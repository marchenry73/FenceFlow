# Idea, parked: drive around, scan the place, quote it on the spot

March, 18 October 2026. **Nothing here is built. This is a note to come back to.**

The idea: pull up outside a property, let the phone work out where it is, capture
the place, price the fence there and then, and show the customer a picture of how
it will look before leaving.

---

## The 4K question, answered

He asked whether this needs 4K Google Earth "and other stuff". The honest answer
is no, and buying it would make the picture worse.

**The ceiling is the imagery, not the screen.** From `docs/SATELLITE_IMAGERY.md`,
the sharpest source found for Hillsborough is the county's own orthophotography,
`AerialsNew/Aerials2025_3_inch_MrSid`, flown 5-25 January 2025 at **3-inch
(~0.076 m) pixel resolution**. Free, keyless, no API key, Hillsborough only. The
app already draws at Web Mercator zoom 21 (`SAT_ZOOM_CAP = 21`, quote.html:2637),
about **2.6 in/pixel** -- which is already a shade past what the source natively
holds. Zoom 22 and 23 return 404 from every provider tried.

**What that means in pixels.** A 100 ft lot frontage at 3 in/pixel is
`100 x 12 / 3 = 400 pixels` of real detail. A 4K frame is 3840 pixels wide. To
fill it from that lot you would upscale about **9.6x** -- a big, soft image, not
a sharp one. Filling 4K honestly at 3 in/pixel needs about **960 feet** of ground
in frame, which is a city block, not a back yard.

**Google Earth would be a downgrade, not an upgrade.** Google's satellite and
aerial layers are typically 15-30 cm per pixel (roughly 6-12 inches) -- coarser
than the county's 3-inch. The repo's own survey already reached this conclusion:
the county ortho is "the newest, sharpest imagery of any source checked for this
specific county". There is also a licensing question with putting Google imagery
into a commercial quote that the county service does not have (its attribution is
"Pictometry International / Hillsborough County Property Appraiser").

So: **no 4K imagery subscription. The money does nothing.**

### What IS worth rendering at 4K

- **The drawn fence itself.** Lines, posts, panels and labels are vector. They
  stay crisp at any size, so a high-resolution export of the plan is worth having
  -- the background is the only part with a ceiling.
- **A ground-level photo he takes himself.** Any recent phone camera is 12-48 MP,
  far beyond 4K. For "here is how it will look", a photo from where the customer
  will actually stand, with the fence drawn into it, beats any aerial. The aerial
  is for measuring; the photo is for selling.

---

## What the idea would actually need

Rough shape, for when this gets picked up:

1. **Where am I.** GPS fix to a parcel. The county parcel layer would give the
   boundary, which is a better starting outline than tracing by eye.
2. **Capture.** Either the existing satellite trace, or a walk-around with the
   camera. Worth checking what the phone's own sensors give: recent Androids
   expose depth, and ARCore can measure a run by walking it.
3. **Price it there.** The engine already does this. Nothing new.
4. **Show them.** The selling half, and the part that does not exist: the fence
   composited into a photo of their own yard, at the chosen height, style and
   colour.

**The honest risk:** step 4 is the whole idea and also the hardest part. Steps
1-3 are mostly assembly of things the app already does.

---

## Open questions for March

- Is the picture for the customer a **photo with the fence drawn in**, or an
  overhead plan? They are different builds and the photo one is much harder.
- Does this need to work outside Hillsborough? The 3-inch imagery stops at the
  county line, and outside it the fallback is materially coarser.
- Offline: a driveway with no signal is exactly where this gets used. The tiles
  and the parcel data would have to be cached before setting off.
