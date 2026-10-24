-- r39: "Issue a product key" could not mint a key.
--
-- SYMPTOM, from the office: `function gen_random_bytes(integer) does not exist`,
-- every time, so no company could ever add a phone this way.
--
-- CAUSE: mint_device_key is SECURITY DEFINER with `SET search_path TO 'public'`,
-- and it called gen_random_bytes() unqualified. pgcrypto is installed in the
-- `extensions` schema on this project -- gen_random_bytes exists there and NOT
-- in public -- so from inside this function the name genuinely does not
-- resolve. Pinning search_path is correct for a definer function; the call
-- simply has to say where the function lives.
--
-- THIS LESSON WAS ALREADY LEARNED HERE. supabase_onboarding_patch.sql's own
-- header says gen_random_bytes lives in the extensions schema and must be
-- schema-qualified, and supabase_mail.sql does qualify it. mint_device_key was
-- written without that knowledge and nothing caught it, because the failure
-- only happens when somebody actually presses the button.
--
-- THE BODY BELOW IS THE LIVE DEFINITION, with exactly one token changed:
-- gen_random_bytes -> extensions.gen_random_bytes. Nothing else about the
-- function is touched -- including the upper()-then-translate order, which has
-- its own comment explaining the bug it already fixed.

CREATE OR REPLACE FUNCTION public.mint_device_key(p_label text DEFAULT ''::text, p_days integer DEFAULT 7)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  co uuid; me uuid := auth.uid(); my_role text; new_code text; tries int := 0;
begin
    if me is null then raise exception 'You must be signed in.'; end if;
    select p.company_id, p.role::text into co, my_role from profiles p where p.id = me;
    if co is null then raise exception 'You are not in a company.'; end if;
    -- Only the people who already decide who works here.
    if my_role not in ('OWNER', 'MANAGER') then
        raise exception 'Only an owner or a manager can give out a device key.'
          using errcode = '42501';
    end if;

    -- No O, no 0, no I, no 1, no L: this gets read out over a phone line from
    -- a van, and O/0 and I/1/L are what get heard wrong.
    --
    -- upper() FIRST, then translate. The other way round -- which is how this
    -- was written -- translates the uppercase O and I out and then upper()
    -- puts them straight back, because base64 also emits lowercase o and i.
    -- So the generator promised a code with no ambiguous characters and
    -- produced them anyway, roughly one code in three.
    loop
        new_code :=
            substr(translate(upper(encode(extensions.gen_random_bytes(12), 'base64')),
                             'O0I1L+/=', 'XYZWVUTS'), 1, 8);
        tries := tries + 1;
        exit when not exists (
            select 1 from device_keys k
             where k.company_id = co and upper(k.code) = upper(new_code));
        if tries > 20 then raise exception 'Could not make a unique code; try again.'; end if;
    end loop;

    insert into device_keys (company_id, code, label, created_by, expires_at)
    values (co, new_code, coalesce(p_label, ''), me,
            now() + make_interval(days => greatest(1, least(coalesce(p_days, 7), 30))));

    return new_code;
end;
$function$
;

-- Proof, without minting anything into a real company: the expression the
-- function now uses must produce an 8-character code with none of the
-- characters that get misheard over a phone line.
select
  substr(translate(upper(encode(extensions.gen_random_bytes(12), 'base64')),
                   'O0I1L+/=', 'XYZWVUTS'), 1, 8)                       as sample_code,
  length(substr(translate(upper(encode(extensions.gen_random_bytes(12), 'base64')),
                          'O0I1L+/=', 'XYZWVUTS'), 1, 8))               as code_length,
  (select pg_get_functiondef(p.oid) like '%extensions.gen_random_bytes%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'mint_device_key')       as now_qualified;
