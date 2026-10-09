UPLOAD AI DESIGN
Status of the work so far

This note is written in plain text so it can be shared as a .txt file.


WHAT THE APP DOES

A customer drops one design photo.
The app removes the background, then builds front, back, left, and right views of that garment.
The customer can open a beta 3D view of those four pictures.
Upload design builds a proof PDF and the browser downloads it. The PDF is the result. It is not saved as an order.

The button shows "Submitting proof" and a percent while that runs. That wait is only for this proof of concept, so we can demonstrate the PDF being built in front of the customer. In the real product the customer will upload and leave. They will not sit on the button. The proof still waits on Gemini and then on each Magnific image, so in this demo it can take a few minutes. The percent is there so the person watching can see the request is still working and how far along it is, instead of a button that looks stuck. The number moves when a step finishes: reading the sheet, then each image, then building the PDF. It reaches 100 when the file is ready to download.


WHAT IS DONE

1. The home page is the upload dialog. The old design studio, catalog match, orders page, and other API routes were removed.

2. One photo becomes a 2x2 sheet: front, back, left, right. Those four views still show on the page. The prompt now asks for a solid garment with depth, turned in 90 degree steps, instead of a flat drawing. A new set of views has to be generated before that change can be judged. Pictures already on screen were made with the older prompt.

3. Upload design does this, in order:
   - Gemini reads the 2x2 sheet and lists team marks and roster marks (player name and number), plus garment fill colors.
   - Magnific redraws the front and the back, and redraws each mark on a white background.
   - Those images are built into the proof PDF in memory and sent back as a download.
   The side-view pictures are not put in the PDF, and they are not generated again for the proof. Sleeve marks still come from the sheet.

4. Magnific image edits for the proof run in two waves. The first half run together, then the second half. This is faster than one pair at a time. Starting every edit at once was failing with a Magnific credit error.

5. The PDF follows the FreeStyle proof layout:
   - Page 1: order summary, front and back, garment info, fill colors.
   - Next page: team and company decorations, then roster decorations. Each row has the placement name, the art, the color dots, and the size line.
   - Last page: roster table and the customer comment.
   Pages end after the last line, so they are not a full blank letter page under the content.

6. Values that are not coming from the upload are filled in by hand and drawn on a light red background, so they are easy to spot. Names, pictures, and colors that come from Gemini or Magnific are not highlighted.


WHAT IS STILL OPEN

Colors.
Gemini does not yet return a reliable color list for every mark. Sometimes a listed color is not actually in that mark. Sometimes a color that is in the mark is missing. The prompt was tightened so a color counts only when it is printed inside that one mark, and so the garment cloth is not copied onto the mark unless the mark is printed in that cloth color. That reduced invented colors. It is not solved. The next pass should make the list match the inks in the mark: no extras, and no missing inks. Do not hardcode colors from any sample jersey.

3D views.
The four-view prompt was updated to ask for volume. It still needs a fresh generation and a look at front, back, left, and right before we call it done.

Real order data.
The red fields below are still sample text from one reference proof. They need to come from the real order when that data exists.

Measurements.
Every mark is labeled 1.5 inch. Offsets are all zero. Real width, height, and placement offsets are not measured yet.

Customer form.
Category, name, email, and message are collected on the page. They are not written into the PDF.

Vercel free plan.
Proof PDF generation can fail on a Vercel Hobby (free) account. The proof waits on Gemini and then on many Magnific image edits. That work can run longer than the free plan allows for one request, so Upload design can error even when the same flow succeeds elsewhere.


HARDCODED VALUES TO REPLACE

These are the same on every proof until we have real data. They are the light red fields.

Order block
- REF#: S6071854
- Total quantity: 1
- Ecom order#: 65486587642357
- Artist: MQ

Garment block
- Style #: 228435
- Size: MOCKUP
- Qty: 1
- Design: CUSTOM (STRIKEOUT)

Roster table
- Style: 228435
- No: 10
- Name: PLAYER
- Top size: MOCKUP
- Qty: 1

Customer comment
- The long note about recreating a youth jersey on a ladies style because the wrong SKU was used and the strikeout template was not available.
- The Momentec configurator URL stored with that note.

On every decoration row
- ADJ: U:0  D:0  L:0  R:0
- Number rows: SENTINEL: 1.5 INCH
- Name rows: FULL BLOCK: 1.5 INCH
- Other marks: ART HEIGHT: 1.5 INCH and ART WIDTH: 1.5 INCH

Also fixed, but not printed as a red field
- The FreeStyle header is cropped from assets/pdf1.png.
- A Fuze pad-print note exists in the code and is not drawn on the PDF.


WHAT COMES FROM THE UPLOAD

These are not hardcoded.

- The four view pictures.
- The front and back pictures on page 1.
- Each decoration picture.
- Placement names, such as where the mark sits, then the word SUBLIMATION.
- Garment fill colors: role, name, and hex.
- Each mark's color names and hex values.
