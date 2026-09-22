# The second factor protects the page, not the door

**What you have to decide:** whether FenceFlow's own staff sign-in should
require your authenticator code at the *database*, not just on the admin page.
Nothing here is urgent enough to do today, and one of the options could lock you
out of your own console, which is why it is written down rather than done.

---

## What is true right now

You set up an authenticator app for the FenceFlow staff console. It works: the
page will not open without the six-digit code.

The code protects the **page**. It does not protect the **database behind it**.

I checked this rather than assuming. There are thirteen staff functions in the
database, and not one of them asks whether you used a second factor. Neither
does the function that decides whether somebody is FenceFlow staff at all.

So: somebody who had your password, and only your password, could not open the
console — but could still reach the thirteen functions directly with ordinary
tools. Ten of those thirteen change something.

## What they could actually do

With the password alone, in plain terms:

- **Suspend or un-suspend any fence company on the platform.** A suspended
  company's crews lose access immediately.
- **Create a company**, grant it access, start or extend its free trial.
- **Promote a release to every phone in the field.**
- **Read the list of companies**: names, plans, whether each is suspended, and
  counts.

What they could **not** do, and this is worth saying because it bounds the
damage: staff access grants no reach into any fence company's actual work. Not a
customer, not a job total, not a penny of anybody's revenue. That was checked
separately and it still holds. The exposure is to *accounts and subscriptions*,
not to your customers' money or their jobs.

There is also only one staff account, and it is yours.

---

## Your options

**1. Leave it.** Cost: nothing. Risk: your password is the only thing between an
attacker and suspending every company on the platform. Reasonable while you are
the only customer of your own product; much less reasonable the day real
companies are paying.

**2. Require the code on the destructive ones only** — suspend, un-suspend,
grant access, promote a release. Reads and trial extensions stay as they are.
Cost: a small change to four functions. This is the option I would choose.

**3. Require the code on all thirteen.** Cost: same work, slightly more of it,
and the console asks for a code more often. Little extra protection, since the
reads give away nothing a competitor could use.

**4. Require it inside the "is this person staff" check itself.** Tempting
because it is one line. **Do not do this one.** That function is called all over
the place, including from things that are not the console, and a second factor
demanded in an unexpected place fails in ways that are hard to trace.

## The part that matters most: not locking yourself out

Whatever you pick, **do not enable it until there is a way back in.** Today
there is exactly one staff account, one authenticator, and one phone. Lose the
phone with option 2 or 3 live and you cannot suspend, un-suspend or release
anything until the factor is reset — and resetting it is itself an admin action.

Before turning any of this on, one of these must exist:

- a second staff account on a different device, or
- the recovery codes saved somewhere that is not that phone, or
- a written way to clear the factor straight from the database.

That is not optional caution. An authentication change that strands the only
administrator is worse than the exposure it closes.

## What about the office console, for fence companies?

Separate question, and my answer is not yet. They are small contractors, mostly
on one phone, and the thing an attacker gets from a stolen office password is
one company's own data — bad, but bounded, and already governed by the
permission rules. Forcing a second factor on every contractor before anybody is
even paying will cost more signups than it prevents break-ins. Revisit when
there are enough customers that one of them asks.

---

**Recommendation:** option 2, and only after the lockout answer exists.
Confidence: high on the finding, which is measured, not guessed. Moderate on the
timing — this is a real gap, but it is not the thing most likely to hurt the
business this month.

---

## If you lose the phone

The staff console's code comes only from the authenticator app. There is no
email code and no way around the code from the page itself -- that is what it
is for. The way back in goes through the Supabase project, which has its own
sign-in and which only you hold:

1. Sign in at supabase.com and open the FenceFlow project
   (`newcrgafcptspmapacrx`).
2. **SQL Editor -> New query**, put your own staff address in, and run:

   ```sql
   -- Removes the authenticator(s) on the staff account. Nothing else changes:
   -- no company, job, payment or setting is touched.
   delete from auth.mfa_factors
    where user_id = (select id from auth.users where email = 'your staff email');
   ```

3. Open `fenceflowapp.com/admin.html` and sign in with your email and
   password. No code is asked for now, because the account has none.
4. **Account -> Turn on two-factor**, and scan the new QR code with the new
   phone. The entry is labelled **FenceFlow** (entries set up before
   22 September 2026 said "localhost" instead).
5. **Account -> Sign out of all devices**, so any session the lost phone still
   holds ends too.

Anyone who can run SQL on the project can do step 2, which is why the Supabase
account itself needs a strong password and its own two-factor. Until a second
staff account or saved recovery codes exist (GO_LIVE.md, item 3), this is the
only way back in.
