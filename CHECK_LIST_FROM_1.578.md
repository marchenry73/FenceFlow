# FenceFlow check list: app 1.578 to 1.663 (3 to 5 October 2026)

This covers the 82 changes between 1.578 and 1.660, plus a short section at the
end for what moved in 1.663. Tick each box as you go.

**Ground rules**
- **LOOK, DO NOT PRESS** means read only. Makayla and the James Bond and John Beaunissant jobs are real jobs with real money on them.
- Practise only on a job named **TEST - delete me**. When you finish, delete those jobs from their job screens (Delete Job), and only ones with that name.
- Test email goes to your own address only, never a customer's.
- "Expected to fail" means I read the code and think the item is broken. What you see settles it. Tell Claude what you saw.
- House rules: Crew never sees money and never deletes anything. Every visible control works, says why it doesn't, or isn't there. An empty list never means good news.

## Do these first

1. **Gate posts on the bill (Phone).** A gate post and an end post are different catalog rows at different prices. The post count can be right while the money is wrong, once per gate on every job with a gate.
2. **Attaching two sides (Phone).** Footage is labour and the quote is by the foot. The slide must keep the length, carry the gates, and take the shared post off the order exactly once.
3. **Office price against phone price (Office).** If the office is lower, one click on Re-price writes the lower figure onto the contract. Compare on a finished job, read only.
4. **Placeholder guard in email (Office).** Before 5 October nothing checked, so "Hi {{customer_first_name}}," could reach a real customer under your company name.
5. **Filing real email (Office).** I expect the Filed folders all to show the Inbox, with no way back for archived, snoozed or trashed mail. Don't file a real customer's mail until this is sorted.
6. **The three real jobs (Office).** Re-pricing or approving at the wrong figure locks it in, and James Bond and John Beaunissant have already lost about $31,000 of lines between them. LOOK, DO NOT PRESS.
7. **Follow-up email switches (Office).** Once a rule is ticked and saved, these send real email to real customers. Look only.
8. **Still owed (Office).** It decides who you ring. The tile and the Money owed table must agree.

## Phone

**Throwaway job for the checks below.** Jobs list, tap the **+** (New job), type **TEST - delete me** in Customer name, tap **Survey & Draw**.
- On the empty drawing tap **New fence run**. The Draw segment is already selected.
- Tap a start point, then tap about 100 ft away in a straight line.
- Tap the grey bar at the bottom centre to open it. Under "Segment lengths — tap one to set it exactly" tap the chip "1: ...", type **96** in Length in the "Set this length" box, and tap Save.
- The bar should read **96.0 ft total | 0 corners | 0 gate(s)**.
- Never practise on a real job. In the Draw tool any stray tap adds a point, and on an approved quote any drawing change withdraws the customer's approval.

- [ ] **The app opens and old markers survived the update.** This build changed the phone's database (version 50 to 51). Open the app; your jobs should be listed with no crash. LOOK, DO NOT PRESS: open an older real job where you marked a house, tree or pool, then tap Survey & Draw (map icon at the bottom of the job screen). It opens in Draw, where one tap adds a fence corner, so first tap **Move View**. It is the last button in the bar at the top, so swipe the bar left to reach it. A hint "Drag to move the view" appears.
  - See: every old marker where it was, with its colour and label, still a plain dot with a white ring. None has turned into a box or vanished. If one is missing, check Layers has site markers ticked. Press back and touch nothing else.

- [ ] **Gate in the fence line.** On the 96 ft Side 1, tap the **Gate** segment at the top and tap the middle of the line. In the "Gate" box set **Feet** to 4, leave "In the fence line" selected, and tap **Add Gate**. Tap **To Estimate** (bottom left). On the Side 1 card press **Suggest Quantities**, read the grey box "What this job needs", and tap **Why?** beside Total posts.
  - See at 6 ft panels and 6 ft spacing: Fence length 96 ft, Gates 1, Line posts 14, End posts 2, "Gate posts (end posts + stiffener)" 2, Total posts 18, Post caps 18, Panels 16, Concrete 19 bags, and 1 each of Hinge sets, Latches, Gate handles, Gate braces and Econo stiffeners.
  - At 8 ft and 8 ft: Line posts 10, End posts 2, Gate posts 2, Total posts 14, Post caps 14, Panels 12, Concrete 15 bags.
  - **The priced list under the box is what changed.** Each row carries your catalog name, with a second line like "1 ea x $16.56". The gate post row should show quantity **1** (it used to be 2), the End Post row **3** (the two fence ends plus the gate's latch side), and the Line Post row 14 (or 10). The box still says Gate posts 2 and End posts 2 because it counts holes in the ground, so box and list won't match line for line.
  - The sheet is titled "Why 18 posts?". It reads: Fence line 96.0 ft; Gate openings come out -4.0 ft; Fence to post 92.0 ft; At 6.0 ft spacing 16 bays; One more to finish an open run +1; One fewer per gate -1; Posts along the line 16; Of those, ends 2; Line posts 14; Gate posts, two per gate +2; Total posts 18.
  - If your spacing is different, bays = (fence feet minus gate feet) divided by spacing, rounded up.

- [ ] **Waste allowance starts at None.** On the same Estimate screen scroll past the Side 1 card to the **Waste allowance** card. It has four chips: None, 5%, 10%, 15%. **None** must be the selected one (no chip reads 0). Any other chip adds panels and concrete.

- [ ] **Gate that runs on to a wall.** Tap the **+** just right of the side picker (no text; Android calls it "Add a second, separate fence run") and choose **New fence run** to make Side 2. Keep it 30 ft or more from Side 1 so nothing snaps. Draw about 100 ft and set its length chip to 96. In Gate mode tap the middle, set Feet to 4, and under "Where is it hanging?" choose **In the line, fence runs on to a wall**. Tap Add Gate, then To Estimate, Suggest Quantities on Side 2, and Why?.
  - See at 6/6: Line posts 14, End posts 2, Gate posts **3**, Total posts **19**, Post caps 19, Panels 16, Concrete 20 bags. At 8/8: 10, 2, 3, 15, 15, 12, and 16 bags.
  - Priced list: the gate post row at **1**, the end post row at **4** (two fence ends, plus the gate's latch side and the post where the run stops at the wall). That is one post more than the in-the-line gate, by design. Post caps must equal Total posts.
  - The "Why 19 posts?" sheet ends "Gate posts, two per gate +3". The words say two, the number is three, and the number is right.

- [ ] **Attach two sides.** Start a fresh TEST job so the numbers aren't mixed.
  - Side 1: draw about 100 ft and set its chip to 100.
  - Side 2: tap the **+** beside the "Editing run" picker, choose New fence run, tap its first point about 15 ft below the right-hand end of Side 1 (3 ft or closer snaps by itself), draw about 50 ft further down and set the chip to 50.
  - Gate: in Gate mode tap Side 2 about 10 ft from its bottom end, Feet 4, "In the fence line", Add Gate.
  - Estimate: press Suggest Quantities on both sides. There is no job-wide post line, so add the two Total posts yourself: 18 + 10 at 6 ft, or 14 + 8 at 8 ft.
  - Back on the drawing, pinch to zoom in, because the tap target is only about 40 screen pixels. Open the **Attach** tab. The hint reads "Tap the end of a side to attach it." Tap the top end of Side 2 first, then the right-hand end of Side 1, read the box, and tap **Attach**.
  - See the box titled "Attach these two ends?":
    - "Side 1 (Vinyl) and Side 2 (Vinyl) would meet at one post."
    - "One post fewer in the ground: 1 post, 1 post cap and that post's concrete come off the order."
    - "2 end posts become one corner post."
    - "It is billed on Side 1 (Vinyl), the taller side."
    - Two amber lines: "Side 2 (Vinyl) slides 15' across to meet it, keeping its length. Its far end moves too." and "Side 2 (Vinyl) still measures 50', so its labour does not change." The distance is the exact measure (it may read 15'3"). There is no distance limit any more.
  - After Attach: Side 2's top end sits exactly on Side 1's end, and the whole side has moved up about 15 ft, still straight. Pick Side 2 in the Editing run picker and the bar reads **50.0 ft total | 0 corners | 1 gate(s) | 150.0 ft job total**. The 4 ft gate is still about 10 ft from Side 2's bottom end.
  - Open To Estimate without pressing Suggest Quantities. Side 1 shows Corner posts 1 and End posts 1, and Side 2 shows End posts 1. Side 2's Why? sheet has "Shared where two sides meet" -1, and Side 1's has no such row.
  - Totals: at 6 ft the posts go from 28 to 27 (Side 1 18, Side 2 9) and concrete from 29 to 28 bags. At 8 ft the posts go from 22 to 21. Panels (17 + 8, or 13 + 6) and fence feet (150) do not change.
  - Known wording flaw: "the taller side" is wrong when the heights differ, because the code then bills the shared post to the shorter side.

- [ ] **Attach where the far end is already joined.** Add Side 3 with the **+** beside the side picker (New fence run). Put its first point about 15 ft to the right of Side 2's bottom end (not on it), draw about 40 ft further right and set its chip to 40. Open **Attach**, tap Side 2's bottom end, then Side 3's left end. Read both amber lines, tap Attach, then look at Side 2's length chip in the grey bar and at the Side 1 / Side 2 corner.
  - **Expected to fail on wording.** The box will still say Side 2 slides and keeps its length. What the code does is move only Side 2's bottom end, so Side 2 **stretches** to about 52'2" and the corner with Side 1 stays joined. Report the wording if the drawing stretches while the box says otherwise.
  - Report it as a money bug if the Side 1 / Side 2 corner comes apart. Side 1 should still show Corner posts 1, unless Side 2 is the taller side.

- [ ] **Crew phone (only if you have a crew login assigned to the TEST job; otherwise skip).** The job needs one drawn side, one gate and one site marker. Sign in as crew, open the TEST job, then Survey & Draw.
  - **Should pass:**
    - The row beside the run picker has the **+** and no trash-can (the delete-run button is hidden for crew), and there is no teardown-charge row under the drawing.
    - **To Estimate** shows a panel "Your access changed" saying You no longer have "See money", with a **Go back** button and no figures.
    - The "Fence on each side" card (reads like "2 sides · Vinyl"; tap its header to open) shows each side's name, type dropdown and height, with no dollar sign.
  - **Expected to fail your "crew never deletes" rule:**
    - Mark Site, then tap the plan. Under "Already marked:" each marker has an x ("Remove marker") that removes it at once with no question.
    - Tapping an existing gate offers "Remove this gate?" (Remove / Keep).
    - Tap the grey bar at the bottom to expand it. An outlined "Clear" button offers "Clear this drawing?" (Clear / Keep).
  - Report which of the three crew sees. I predict the removed marker comes back after the next sync, because a crew phone never sends its delete.

- [ ] **The house is a box.** On a TEST job tap **Mark Site**, then tap an empty spot on the drawing. The "Mark this spot" box opens (it doesn't open from the button alone). Tap the **House** chip, set Width ft 40, Depth ft 30, Turn ° 20, and tap **Add Marker**. Draw a 40 ft side beside it for scale.
  - See a faint filled rectangle with an outline, 40 ft by 30 ft to the same scale, turned 20 degrees clockwise, with the coloured dot and white ring at its centre and the label "House".
  - House, Pool and Driveway show "Size on the ground, in feet. Leave blank for a simple marker." Tree, Slope, Easement, Utility, Obstacle and "Old fence (note only, not charged)" show no size boxes. A box draws only when both Width and Depth are filled.
  - Add a Pool with Turn 450: it draws as 90. In Adjust, drag the house's dot: the whole box moves and keeps its size. Force-close the app, reopen the job and Survey & Draw: it is still a box.
  - **Only this screen draws the box.** The crew plan and the pull sheet plan still show a plain dot, and the customer's quote page draws no house at all (it only reads the house's position). There is no way to edit a marker's size: remove it with the x under "Already marked:" and add it again.

- [ ] **The gate dialog's small print.** In Gate mode tap the canvas and read the three lines under "Where is it hanging?". To see the third choice on the bill, add another 96 ft run 30 ft or more from the others, put a 4 ft gate on it, choose **Off the wall**, tap Add Gate and press Suggest Quantities.
  - The small print currently reads: In the fence line, "End post, set in concrete (2 bags)". In the line, fence runs on to a wall, "Two end posts, concrete". Off the wall, "Blank post + end post, 4 hole plugs, no concrete".
  - **Expect those words to be out of date.** The bill follows your rules: 2.5 bags per in-the-line gate, 3.5 for the wall gate. Off the wall gives Total posts 18, Concrete 17 bags, Hole plugs 4. That is End Post x3, one post line x1 named like your Gate Post row, and the hole plug line x4 under your catalog name. "No concrete" is wrong, because the latch post still goes in one bag.
  - Tell Claude the wording needs fixing. The bill is what to trust.

- [ ] **Other runs fade in at low zoom.** On a TEST job with two or more runs, open Draw at 1x zoom. The runs you are not drawing should be faint. Tap the plus zoom button (top right, under Layers, icon only) about five times, looking after each tap.
  - See: they get steadily stronger and are solid from about 3x (the fifth tap is the first fully solid). The run you are drawing keeps its vertex dots and length labels. The minus button fades the others back.
  - The Fence layer must be on in Layers (it is by default), and switching runs resets zoom to 1x.

## Office

### Money and real customers

- [ ] **Office price matches phone price.** Pick one finished job that is not Makayla, James Bond or John Beaunissant (or use a TEST job you ran Suggest Quantities on). **LOOK, DO NOT PRESS.**
  - On the phone open the job, tap **Estimate** (next to Survey & Draw) and read Materials, Labor, Tax (reads "Tax (7%)"), Subtotal and TOTAL.
  - In the office go to Jobs, open the same job, then Estimate & Pricing. Press only **Show full breakdown** (owners and managers only; a job whose wizard is unfinished opens the wizard instead, so pick another). Read Materials, Tax, Labour, Subtotal, Grand total.
  - See every pair match to the cent, with odd cents rather than round tens.
  - Never press "Re-price at the office" or Suggest Quantities on a real job. On a job with a gate last priced on the phone before this build, the post lines can honestly differ until the phone runs Suggest Quantities again. A catalog price changed since can also differ. Write any difference down and tell Claude the job and which pair. A few dollars off means stop.
  - A grey note under Grand total about rounding up to the next $10 is stale wording. It should only show when the minimum job charge lifted the total.

- [ ] **LOOK, DO NOT PRESS: Makayla, James Bond, John Beaunissant.** Jobs tab, open each, read only the "Estimate & Pricing" panel. Scroll past "Show full breakdown" and "Re-price at the office" without tapping. Do not press Re-price, "Keep this price", Approve, Send or Pay, and do not press Suggest Quantities on the phone.
  - **Makayla:** the "Fence Runs" panel higher up shows three cards (Back, Left Side, Right side), each Vinyl. The item table has about 24 lines and no "Corner Post" line. Panel lines are two "Panel T&G White PVC 6'H x 6'W" and one "Panel Melrose Flat Top 2-Rail 4'H x 6'W". Total readout $4,420.37. The two $16.56 corner post lines were removed by hand on 1 Oct, on purpose.
  - **James Bond and John Beaunissant:** the item table is empty and says "No estimate yet. Run Suggest Quantities in the app." Do not follow that on these two. Their lines were lost on 1 Oct (James 13 lines worth $21,510.71, John 18 lines worth $9,475.34) and have not come back. Totals read $13,266.87 and $5,853.81, with "Priced in the app from the runs, estimate and the rates below." They signed for $35,240.00 and $15,540.00, which are not on this readout. That is the known state, and there is nothing to repair by pressing buttons.
  - On the phone, don't open Makayla's Estimate unless "Deposit amount ($)" on her job screen is already filled in (it read $3,000 when checked).
  - If anything looks different from this, tell Claude.

- [ ] **Still owed leads to the money.** Reports (left column, under INSIGHTS) must have **Detailed tables** open (click its heading until the arrow points down). Then go to Dashboard, MONEY group, and click the **Still owed** tile. LOOK ONLY; don't press Export CSV.
  - See Reports open scrolled to the "Money owed" panel (columns Customer, Status, Contract, Paid, Outstanding, Days). The pinned date strip may cover the heading, so scroll up a touch.
  - There is no total row, so add up the Outstanding column. It should equal the tile, normally to the cent. The date strip still says Last 90 days, and the table ignores it because what you owe is a standing balance.
  - **The table must not say "Nothing outstanding." while the tile shows dollars.** If it does, reload once and tell Claude. On a Crew plan the table reads that by design. On a Solo plan the tile has no click at all.
  - Fold "Detailed tables" shut and click the tile again. Expect to stay where you were with no table in sight, because the click only scrolls and never re-opens a section. That is a known gap.

- [ ] **Follow-up priority panel is current.** Reload the office (Ctrl+Shift+R). On the Dashboard, scroll to **Follow-up priority**. LOOK, DO NOT PRESS: these are real customers.
  - See the heading "Follow-up priority", not "Chase list". If it still says "Chase list" you have a stale copy or the publish hasn't finished.
  - The ranked rows (1, 2, 3...) come first, with three tiles underneath: VALUE IN PLAY (N), WON THIS WEEK (N) and LOST, ALL TIME (N). N in the first equals the number of rows. With nothing open the list says "Nothing open to chase right now.".
  - **Each Quote Sent row's button must match that job's own sheet.** Click the customer's name only (it opens the job). In the "Customer quote page" panel the status line is below "Copy link" and "Preview it".
    - "Viewed <date and time>, not approved yet." means the button says **Opened it - nudge them**.
    - "Sent <date>, not opened yet." means **Never opened - resend or ring**.
    - An empty Email box means **No email on file - call them**, and this wins over the other two.
    - "Approved by <name> on <date>." takes priority over Viewed and Sent, though an empty Email box still wins.
    - Nothing should read plain "Follow up". Approved rows say "Collect deposit".
  - On the job sheet do not press "Preview it" (it stamps the quote opened and flips that label for good), Copy link, Save Changes or Delete. On the list do not tap Call, Text, "Mark contacted" or the grey button.
  - This morning's notes had Makayla and John Beaunissant opened and James Bond with no email. The real test is that each button matches its own sheet.

- [ ] **The "Click the bar to see the math" line.** In the same panel, hold the mouse over the thin coloured bar under a person's name, then click it. You need at least one open row.
  - See a tooltip like "Priority score N = $X value multiplied by Y days waiting". For "not priced yet" rows it begins "Not priced yet, so there is no value to rank it by."
  - **I expect the click to do nothing.** The bar has only a hover tooltip, and a phone has no hover at all. If so, the intro sentence promises a control that doesn't exist, which breaks your no-fake-features rule. Tell Claude what you saw. Don't click the name or row buttons.

- [ ] **Sales follow-up emails: LOOK ONLY, tick nothing.** Automation tab (left menu, under Insights; hidden on Solo), panel "Sales follow-up emails". **Ticking a rule, pressing Save and having the top switch on lets an hourly job email real customers.** Do this before you create test jobs, and never put an email address on a test job: it would add itself to "New lead not contacted".
  - See a small grey line beside each rule ("New lead not contacted", "Quote sent, not opened", "Quote opened, not approved", "Approved, no deposit"): "N waiting now" or "none waiting". It isn't red.
  - This morning's figures were 1, none, 2, none. Yours can differ if jobs moved.
  - What must hold:
    - "Quote opened, not approved" is never more than the number of "Opened it - nudge them" rows on the Dashboard, and a "No email on file - call them" row is never counted. If the numbers disagree, tell Claude before you tick anything.
    - "Approved, no deposit" counts only approved jobs with a deposit actually asked for (over $0), nothing paid, approved at least the "after (days)" value ago (2 by default).
    - The four numbers can add up to more than the emails that would go, because a job matching two rules gets one email.
    - The numbers show even with the top switch off.
  - At the top you should see a red line: "Switched on, but no rule below is ticked -- so nothing will ever send. Tick the ones you want." Under "What would send right now" the empty message should read "Nothing is due because no rule is switched on. This is not the same as nobody needing a follow-up."

- [ ] **Alerts panel says it is off.** Same Automation tab, panel **Alerts that run with the office closed** (below "Automation rules", above "Flagged jobs"). LOOK ONLY. Don't press "Turn on", and leave "Check now" alone (it belongs to the panel above and acts on real jobs).
  - See a paragraph under the heading, starting "The rules above only run while this page is open. These nine are checked on the server every hour..." and ending "...never change a job, move money or delete anything." It must not be blank.
  - Below it, a row "Off. Nothing is checking these." with a red dot and a **Turn on** button, then "While this is off there is nothing to show here, and nothing being watched. An empty list would not mean all clear." There should be no list.
  - If it is already on, the row reads "On. The server checks these every hour." with "Turn off".
  - Open the account menu (your email, top right), set Language to ES: the heading reads "Alertas que funcionan con la oficina cerrada", the row "Desactivado. Nadie está revisando esto." and the button "Activar".
  - A login that is not owner or manager sees the button greyed with "Only an owner or manager can change this."

- [ ] **The Blocked job chip works and clears.** On the phone, tap **+** (New job) on the Jobs list and type **TEST - delete me** in Customer name. Leave phone and email empty. On the **Held Up / Not Completed** card type **TEST** in "What stopped the job? (leave blank if nothing did)". "Text Customer" and "Email Customer" appear greyed out; do not tap them. Open the Account & Team screen, Cloud Save card, and tap **Sync Now**.
  - In the office press **Refresh** and open Jobs (under WORK). See a chip **Blocked 1** at the right-hand end of the first group of chips, just before the thin divider.
  - Click it. Only TEST - delete me should remain, with "1 of N jobs" and a **Clear** button beside the chips.
  - With Blocked lit, click the status chip **Draft N**: the job stays (new jobs are Drafts). Then click another status chip, such as Accepted, Sent or Completed. You should see "No jobs match that. Clear the search or pick a different status." and **not** "No jobs yet.". Click Clear and every job comes back.
  - With no Blocked chip before you started, that is normal: a chip with nothing behind it is left out on purpose. If one was already there, a real job has a reason typed in. LOOK, DO NOT PRESS: open it only to read and tell Claude if you don't recognise it. The office doesn't show why a job is blocked; read it on the phone's Held Up card.
  - **Un-blocking (expected to fail):** on the phone, delete the TEST text from the box, Sync Now, then Refresh in the office. The chip should disappear. I expect it to stay with the same count, because a cleared field is left out of what the phone sends. If so, that is a real fault. Never clear that box on a real job to test this.

- [ ] **Crew login in the office (only if you have a Foreman or Crew login).** Sign in at fenceflowapp.com/dashboard.html in a private window.
  - See no Email in the left menu, no Email in "+ New", and no "Company email" panel in Settings. If a crew login can't reach the office at all, that is fine too.
  - Click the search box (placeholder "Search customers, jobs, addresses, email") and type two or more letters of a real customer's name. LOOK ONLY. You should see no dollar figure and no job row, probably "Nothing found for <what you typed>". That doesn't mean the customer is missing, because these logins can't read jobs by design.
  - **Money must not leak as zeros.** For Foreman or Crew I expect Jobs to read "No jobs yet.", the briefing to read "All clear — nothing is waiting on you.", and the Money tiles "Collected this month" and "Still owed" to read "$0.00". Those look like good news but mean "you cannot see this". Crew must see no real dollar figure anywhere, and zeros that read as fact are also a fault. Write down what you see.
  - Any login that isn't owner or manager: "+ New" shows "Job" and "Crew member", but those two buttons are switched off for them. I expect both to change tab and then do nothing, which is a dead control. Tell Claude.

### Email

All of this needs company mail on for your login (left menu, Sales group, Email; "+ New" then "Email"). Use your own mailbox and your own address only.

- [ ] **The placeholder guard.** "+ New", "Email". From: your own mailbox. To: **your own address**. Subject: TEST - delete me guard. Message: `Hi {{customer_first_name}},` (type the double braces exactly). Stop typing and **wait a full 6 seconds** before pressing **Send** once. A green "Draft saved at ..." line may appear meanwhile, which is normal.
  - See, at the **top** of the sheet just under "New email" (scroll up if you can't see it): a red bar "This still has {{customer_first_name}} in it, which the customer would see. Fix it, or press Send again to send it as it is." Nothing is sent, the sheet stays open, nothing appears under Sent, and nothing reaches your inbox. An autosaved copy sits in Drafts (clear it with Discard, then confirm Discard).
  - **A second press of Send sends it anyway**, exactly as written. That is by design, so a message that genuinely contains braces isn't locked out. Prove it only with your own address: it arrives reading "Hi {{customer_first_name}},". Never do the second press with a customer's address.
  - If the red bar flashes and vanishes, or you see nothing at all, that is a real bug in the guard. Report it, and do not treat a second press as a retry, because the second press sends.
  - If the sheet says "There is no mailbox to send from yet. Connect one in Settings." or "Add your business email in Settings first. Replies need somewhere to go.", there is nothing to send from. Stop and tell Claude.
  - **Second test:** Subject `Quote for {{customer_name}}`, Message `Hi {{customer_first_name}}, your total is {{quote_total}}.` Press Send and expect a red line naming all three, subject first: "{{customer_name}}, {{customer_first_name}}, {{quote_total}}". Change only {{customer_first_name}} to March and press Send again. It must refuse **again**, naming only the two left. Only with none left does one press send ("Sending…" then "Sent.", and the sheet closes after about a second). It arrives with your words and no braces. Don't press Send a second time without editing.
  - Known gap: the guard only recognises names made of letters, digits and underscores inside double braces (capitals are fine). "Hi [Name],", "{customer_first_name}" and "{{ Customer Name }}" go out untouched.

- [ ] **The Filed folders.** On the Email tab, under **Filed**, press Drafts, Starred, Snoozed, Archived and Trash in turn.
  - See: each press highlights that folder and lists only its conversations. An empty folder says a plain sentence ("No drafts. Anything you start writing is kept here." for Drafts, "No email here yet." for the others), never a blank box.
  - **Expected to fail.** I read the click handler and ran it: every press redraws with Inbox highlighted, so every Filed button just shows the Inbox. If so, **do not archive, snooze or trash a real customer's mail, and don't rely on a closed draft.** Restore only exists inside Archived and Trash, and a saved draft only opens from Drafts, so a filed conversation has no way back. Tell Claude.

- [ ] **Close keeps your words, Discard deletes them.** "+ New", "Email". From: your own mailbox. To: your own address. Message: draft test. Stop typing and count to three. Do not press Send.
  - See a green "Draft saved at <time>." about two seconds after you stop typing, which fades by itself.
  - Press **Close** (top right, in the dark title bar next to "New email"; not Discard). Under the search row on the Email tab you should see "Saved to Drafts." Look straight away, because the next mail check replaces it with "Checked for new mail at <time>."
  - Open a fresh sheet, type some words and press **Discard** (at the bottom of the sheet). See "Discard this email?" with "What you wrote will be deleted. Close instead and it is kept in Drafts." and **Cancel** / **Discard**. Cancel returns you with your words intact. Discard closes and keeps nothing. On an empty sheet Discard just closes with no question.
  - **Expected to fail with the "via FenceFlow" sender.** Repeat with From set to "<your name> via FenceFlow" (skip it if there is no such entry or it is greyed with a "· ..." note). I expect a red line "One of the values is not valid. Check the fields and try again." that stays up, and Close then throws your text away with no warning and no "Saved to Drafts." If so, don't close an email from that sender expecting it to be kept. Tell Claude.
  - Reopening a saved draft from Drafts needs the Filed folders fixed first.

- [ ] **Make four throwaway emails.** For each of 1, 2, 3 and 4: "+ New", "Email", From your connected mailbox (not the "via FenceFlow" one), To your own address, Subject `TEST - delete me 1` (then 2, 3, 4), Message `test`, press Send. Your address is the small-capitals heading above "Inbox" and "Sent" in the left column. If the top group reads ALL MAILBOXES, it is the heading of the next group down. Then press **Check for new mail** (left column, next to "Write an email") and wait up to two minutes. Use only these for the filing checks below.
  - See "Sent." and the sheet closing about a second later. All four appear in the Inbox in bold with a small dot and a "2" (the sent and received copies share one thread). The number beside Inbox and the badge on the Email tab each rise by four, and they also appear under Sent as "To: ...".
  - If the Inbox shows a sentence like "This part of FenceFlow is not available on your account yet. Contact support if it should be.", the new mail functions aren't live on the real database. Stop and tell Claude. If nothing arrives after several minutes, look in the mailbox's own webmail before blaming FenceFlow.

- [ ] **Star.** Hover over the row "TEST - delete me 1" (at phone width the icons are always showing). Four icons appear: "Star", "Archive", "Snooze until tomorrow 8am", "Move to trash". Press the star, move the mouse off, press Check for new mail, reload (F5) and open Email again.
  - See the star turn orange and filled at once, and the email does **not** open. The icon cluster stays showing with the mouse away. The star is still orange after the check and after the reload, with the tooltip "Remove star". Press it again for an outline; the icons stay until you click an empty part of the page.
  - Clicking the row's text still opens the email.

- [ ] **Archive, snooze, trash.** On "TEST - delete me 2" press the box icon (Archive), on "3" the clock (Snooze until tomorrow 8am), on "4" the bin (Move to trash). Press Check for new mail, then reload. Never do this on a real customer's conversation.
  - See each row vanish from the Inbox at once and stay gone after the check and reload. The number beside Inbox and the Email badge catch up after Check for new mail, or within about a minute. Trust the Inbox under "All mailboxes"; per-mailbox Inbox numbers can lag.
  - In the mailbox's own webmail all three are still in its inbox. These only hide the conversation inside FenceFlow and delete nothing from your real mailbox.
  - From the Sent list, Archive and Snooze make the row blink and come back (Sent ignores them); only trash hides it there. The top search box finds archived and snoozed ones under "Email" but can't restore them, and trashed ones don't appear.
  - Nothing on screen brings a filed conversation back while the Filed folders show the Inbox.

- [ ] **Tomorrow after 8:00: the snoozed email wakes.** Look at "TEST - delete me 3" in the Inbox after 8:00 am by your computer's clock. You can't speed this up.
  - See it back in the Inbox on its own, at the date it originally arrived (not jumped to the top), and gone from Filed, Snoozed. If you hadn't opened it before snoozing, it is in bold with the orange dot and the counts include it again.
  - It must not come back before 8:00. Snoozing after midnight still means the next calendar day, so a 1 am snooze waits about 31 hours. If it hasn't returned by mid-morning, tell Claude.

- [ ] **A reply to an archived conversation.** You need a second address of your own that isn't the company mailbox. From it send the company mailbox a message with subject `TEST - delete me 5`. In the office press Check for new mail, open it, hover the row and press the box icon (Archive; it is on the list row, not inside the opened message). Reply from your own address and press Check for new mail again. Look at Inbox, the orange number on the Email tab, then search "delete me 5" in the top search box.
  - A normal mail program would return it to the Inbox as unread and raise the number. **I expect this not to happen.** Nothing un-archives a conversation when mail arrives, so the reply lands in a conversation the Inbox and badge both ignore. The search box still finds it. The same applies to a snoozed conversation until 8 am.
  - A customer who answers "yes, go ahead" on a conversation you tidied away would be invisible to you. If you see this, tell Claude before you archive anything real.

- [ ] **Labels.** Account menu (button with your email, top right) then **Settings**, then the "Company email" panel, and below "FenceFlow mail" the "Labels" section. Type `TEST Permits` in "New label" and press Add. Type `test permits` and press Add. Then open a TEST email in the Email tab. Under the subject on the "Who is answering" row, use the dropdown whose first entry reads "Add a label" and pick TEST Permits. Press the small x on the chip ("Remove this label"), add it again, reload and reopen the email. Back in Settings press the x on the label chip ("Delete"), read the box, press Delete, then reopen the email.
  - See a chip "TEST Permits" with an x. The second add is refused in red: "You already have a label with that name." (capitals ignored). Picking the label puts a blue chip beside the dropdown, and that choice leaves the dropdown; when every label is on, the dropdown disappears. The chip survives the reload.
  - Delete asks "Delete this label?" with "It comes off every conversation it is on. The emails themselves are not touched." Afterwards the chip is gone from the email.
  - Labels show **only inside the open email**. They don't appear on list rows, and you can't list by label. See "Needs your decision".

- [ ] **Email templates.** Settings, "Company email" panel, "Email templates". With Name empty press **Save template**: red "Give the template a name so you can find it later." Click a saved template's name to load it, change the Message and save: "Template saved." and no second copy appears. Press the x beside a template: "Delete this template?" with "Emails already sent with it are not affected.", **Delete** and **Cancel**. Cancel changes nothing; then delete for real. With none left the list says "No templates yet." and "+ New", "Email" no longer shows a "Use a template" row.
  - A new template whose name matches an existing one (ignoring capitals) is refused with a generic duplicate error, not the empty-name message.

- [ ] **Who is answering.** Open a TEST email. Under the subject, "Who is answering" reads "Nobody yet". Pick your own name, reload and reopen, then set it back.
  - See your name stick after the reload. The dropdown lists everyone in the company, crew included. Don't pick a crew member, because crew can't open Email and nobody would see the conversation. It is a label only, shown here and nowhere else.

- [ ] **Mail arrives fast.** From another address of yours, send a short message to the company mailbox. In the office stay on Email, Inbox ("All mailboxes") with the tab in front, and don't press Check for new mail.
  - See it appear and the unread number rise on the Email tab and beside Inbox within about one to two minutes. The page asks every 60 seconds and the server can answer "busy", so don't expect it to the second. The badge is hidden at zero.
  - If the number rose but the list didn't change, press Check for new mail. That is a small flaw, not a failure.
  - With the Email tab closed, a GitHub schedule fetches it, so allow roughly 5 to 10 minutes or more. That works only if the MAIL_SYNC_TRIGGER_SECRET repo secret is set, which I couldn't check.
  - Replies to mail FenceFlow itself sent arrive by webhook, but only while Settings, "Company email" says "Replies come back into the Email tab."

- [ ] **Email on a phone (or a browser window under about 900 px wide).** Open Email. LOOK, and tap only the text of a row; don't tap the icons on a real customer's email.
  - See four small icons on every Inbox row at all times (star, archive, snooze clock, trash), on a right-aligned line at the top of the row. Archived and Trash rows show three (star, put-back arrow, trash), and Drafts shows one (trash/discard).
  - The folders are a vertical column of short labels, with the Inbox unread number flush right (shown only if you have unread mail). One tap on the row's text opens the email, Back returns, and tapping an icon doesn't also open the email. A starred row keeps its filled orange star.

### Menus, tabs and layout

- [ ] **"+ New" has three real items.** Click **+ New** (top bar). See **Job**, **Email**, **Crew member**. Solo plans have no Crew member, and Email is absent if your login has no Email tab. Try each, then close it with **Close** without saving.
  - Job: switches to Jobs and opens a sheet titled "New client" with "Step 1 of 7 — Who" (if business setup isn't finished you get the Business setup sheet instead, which is fine). After Close there is no new job.
  - Email: switches to Email and opens "New email" with From, To and Subject. Close on an untouched one leaves nothing in Drafts. Don't press Send.
  - Crew member: switches to Crew and opens "New Crew Member" with Name, Role and Phone. Close adds nobody.
  - If an entry changes the tab and nothing opens, that is a dead control. Tell Claude which one.

- [ ] **Header, signed out and signed in.** In a private window open fenceflowapp.com/dashboard.html while signed out.
  - See only the logo ("FENCEFLOW OFFICE"), with no search box, no "+ New", no Refresh and no email button, and no flash on first paint.
  - Sign in. See the search box ("Search customers, jobs, addresses, email"), "+ New", Refresh, and a button like "you@example.com · OWNER".
  - Open the account menu. Rows in order: Language (EN ES FR), Appearance (System Light Dark), Settings, Billing, Home page, Sign out. Settings and Billing open their tabs. The logo returns to Dashboard without a reload. Opening "+ New" closes the account menu (one menu at a time), and Esc or a click on empty page closes both.
  - Press **Sign out**: the page reloads and the top bar is back to the logo only.
  - Narrow the window (under about 760 px) or use your phone: the search box drops onto its own row and nothing overlaps.
  - Refresh stays visible beside "+ New" the whole time you're signed in. The commit note says otherwise, but that is harmless.

- [ ] **Left menu groups.** On a window 1024 px or wider, click every entry once. See, top to bottom:
  - Dashboard (no heading)
  - **SALES:** Pipeline, Email
  - **WORK:** Jobs, Schedule, Production
  - **OPERATIONS:** Materials, Catalog
  - **TEAM:** Crew, Time
  - **INSIGHTS:** Reports, Automation
  - **ACCOUNT:** Settings, Billing
  - "Schedule" is the old Calendar and still opens the month calendar.
  - Each entry opens its own screen, but the heading inside isn't always the tab name: Time opens "Clock In / Out", Crew "Crew & Employees", Materials "What to buy", Catalog "Materials Catalog", Automation "Sales follow-up emails", Settings "Business setup", Billing "Your FenceFlow Subscription".
  - As owner you should see Email even with no mailbox connected (it offers "Connect a mailbox"). A missing Email tab for you is a fault. If your plan hides tabs, no heading may sit over empty space.
  - Narrow the window under 1024 px: one flat scrolling row of tabs, no headings, same tabs in the same order.

- [ ] **Jobs chips.** Jobs tab. LOOK, DO NOT PRESS: chips are safe to click, but don't open a job row or tick a box.
  - See, in the first group, **All** (no number), **Today**, **This week**, **Unscheduled**, **Blocked**, each with a count, then a thin divider, then a second **All** with the total, then Draft, Sent, Accepted, Completed, Declined (only the ones you have jobs in). A chip with nothing behind it is left out, so Today and Blocked are often missing, and that is right. The first All clears the when-view and the second clears the status.
  - **Today** should equal the Dashboard tile "Jobs today", and **This week** should equal "Scheduled next 7 days" (today plus the next six days, not Monday to Sunday). Schedule agrees if you count only solid chips; faded "continues" chips and "+N more" don't count. Unscheduled counts every job with no date, including Declined and Completed, so it is usually your biggest number.
  - Click This week, then add a status chip such as Accepted. The count beside the chips reads like "3 of 12 jobs" (unfiltered "12 jobs") with a **Clear** button. An empty result says "No jobs match that. Clear the search or pick a different status.", not "No jobs yet.". A job booked for 9am today still shows under Today at 2pm. Chip numbers are totals across all jobs and ignore the search box, so they can exceed the rows you see.

- [ ] **Daily briefing.** Dashboard, panel **Daily briefing**. LOOK, DO NOT PRESS on real jobs. Don't press "Re-price at the office", Send, Approve, Pay, Delete, Save or "Mark contacted". The Follow-up priority buttons also open the job, so leave them alone on real jobs. If a job opens as a "Step N of 7" form, press Close and never Next or Finish. The safe way is the TEST - delete me job from the Blocked check, which should be the "1 new lead" row.
  - See section titles in capitals with a count (for example "SALES (1)"). Every line is a whole-row button with a dot on the left: a **filled red** dot and red text means it needs you now, and a **hollow grey ring** means for your information. A small "›" appears at the right on hover or Tab.
  - "Last 24 hours" rows ("1 new lead", "2 quotes sent", "1 job approved") are hollow rings. They carry a small grey number only when more than one job is behind them, and clicking one opens a small window with the number in large type and the jobs listed under "The jobs" (names are plain text, not links). A needs-you-now row never carries a number; it opens one job or switches tab.
  - Under the sections a grey line "Nothing else today: Production, Crews." names the empty sections, and the bottom line reads like "2 jobs today, 0 on the clock now". With nothing at all it reads "All clear — nothing is waiting on you." with the jobs-today line still underneath. The Money section shows only for logins that can see money. In Dark mode (account menu, Appearance) the red rows turn pale pink-red and stay readable.

## Customer quote

No checks were written for the customer's quote page. That is not a clean bill of health, only that this list doesn't cover it. The one related item is in Phone: the quote page does not draw the house as a box, and only reads its position.

## Admin

Nothing here to click. Every Admin item is a choice, listed in the last section.

## Public site

No checks were written for the public site. That is not a clean bill of health, only that this list doesn't cover it.

## Needs your decision, not your checking

- [ ] **Which follow-up emails to switch on, and for whom.** Master switch "Turn on sales follow-up emails" is already ticked with all four rules unticked, so nothing has ever sent. About $23,540 of opened quotes (Makayla among them) sat unanswered under it. Ticking a rule and pressing Save lets the hourly GitHub "Follow-up email scheduler" email real customers, but only once the FOLLOWUPS_TRIGGER_SECRET repo secret is set. Quiet hours are 21:00 to 08:00, timezone America/New_York, with a "Daily cap (all kinds combined)" of 25.

- [ ] **Whether to turn on the server alerts.** Automation tab, "Alerts that run with the office closed", press **Turn on**. It starts hourly server checks and phone pushes to Owner and Manager accounts only. No customer is emailed or texted. If you do:
  - See a green "On. The first check runs within the hour." that fades, then "On. The server checks these every hour." with "Turn off". Until the first check the list says "Nothing open. The server checks these every hour." Between 9pm and 8am Eastern it says "Quiet hours. Nothing is recorded until 08:00, so an empty list right now tells you nothing either way."
  - After the first check I expect one real alert: "Approved with no deposit taken" for James Bond, with "Approved with no deposit collected: James Bond" and a grey **Clear** button. That is a $3,500 deposit agreed and $0 collected. LOOK, DO NOT PRESS Clear until you've dealt with it.
  - On your phone a notification titled "Needs attention" (or "2 things need attention") with that text, and nothing on crew, foreman or sales phones. The wording says "collected" on the push and "taken" in the list.
  - If **nothing** appears after a day or two, don't read that as all clear. Check GitHub, the repo's Actions tab, "Attention sweep scheduler". Its hourly run exits green with only a notice when the ATTENTION_SWEEP_TRIGGER_SECRET secret is missing, and the office can't tell. "Turn off" gives "Off. Nothing will be checked until you turn it back on."

- [ ] **The 4 ft corner post.** Makayla's two $16.56 corner post lines were removed by hand. Re-pricing her before this is decided either bills the 6 ft post or puts back lines removed on purpose. The supplier's name and price for the 4 ft corner post settle it.

- [ ] **The supplier price request.** `docs/SUPPLIER_PRICE_REQUEST.html` (to print) and `docs/SUPPLIER_PRICE_REQUEST.csv` (to attach), in the FenceEstimator repo. Titled "Price request — vinyl fence", with groups "6 ft privacy", "4 ft closed top" and "Any height (hardware, caps, trim)", and columns Description / Unit / Price.
  - It has 47 live catalog rows, plus one highlighted last row under "4 ft closed top": "Corner Post, 5x5x72, White, 4' Closed Top [NOT IN MY CATALOG - please give your part name]". The footer reads "47 items plus one I am asking you to name."
  - Whether it goes out, and to whom, is your call. Don't send it just to see.
  - When a reply comes back: Catalog tab, "Update prices from a price list" (owners and managers only), choose the supplier, add the file, press "Preview changes". Rows for that supplier appear under "Will change". The other supplier's rows and the corner post row appear under "In the file, but matched to no item", which is expected. Items with no supplier only match if you tick the "Also match the N item(s) that have no supplier yet…" box.
  - Every price flagged ◆ in the Catalog is still the one FenceFlow shipped ("Unverified price — verify with your supplier"), and quotes using those rows are blocked from sending. This sheet is how they become yours.

- [ ] **James Bond and John Beaunissant's lost lines.** They signed for $35,240.00 and $15,540.00. The office shows $13,266.87 and $5,853.81 because the lines lost on 1 Oct haven't come back. Decide how they are put back. Don't use Suggest Quantities or Re-price to find out.

- [ ] **Apply `supabase_r11_time_entry_rate_permission.sql`?** It is written and not applied. It stops a Sales login stating an unverified hourly pay rate on a shift with no matching employee record. Nobody can reach that today (the only Sales profile has no company), so tell Claude to apply it before you create a real Sales user. **Do not run `supabase_a92_can_see_pay_checks_see_pay.sql`.** It is now a comment-only file, because its first version would have taken every salesperson's phone money to defaults on the next sync with no error. After r11 is applied, a Sales phone should still show real prices, markup and deposits, and Crew and Foreman logins still see no money.

- [ ] **Delete the leftover `billing-setup` function?** It is still deployed on the live Supabase project (ACTIVE, version 9). It is a temporary setup utility that can create Stripe products using the project's Stripe secret key, and its own header says it is deleted after go-live. Nothing in the repo calls it. Tell Claude when you want it removed, along with the `supabase/functions/billing-setup` folder so a redeploy doesn't bring it back. Nothing in the app or office should change.

- [ ] **Keep labels and "Who is answering" as they are?** Labels show only inside the open email, with no list by label. "Who is answering" is a label only, and nothing stops you naming someone who can never see the conversation.
---

## Added after this list was built: 1.663

This list was written against 1.660. The build you actually have is **1.663**,
and two things moved after it was written:

- **A gate standing on its own now bills two blank posts** (3 bags of concrete,
  no wall plugs). A gate marked *hung off a wall* with no fence drawn is NOT
  that case: it keeps its 4 hole plugs and takes only 1 bag, because its hinge
  side is bolted to the wall rather than set in the ground. If you draw a gate
  with no fence at all, check which of the two you get -- $426.97 for a gate on
  its own, $417.45 for one hung off a wall, on the starting vinyl catalog.
- **lead.html** no longer shows the enquiry form when the link has no company
  token on it. Open https://fenceflowapp.com/lead.html with nothing after it:
  you should see a message asking for the full link, and NO form. With a real
  ?c=... link the form is there as before.
