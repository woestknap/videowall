# Aligning screens and mixing physical sizes

Each player shows a window onto one shared image. A screen's resolution determines
how many pixels draw that window; its measured size and position determine which
part of the image it shows. Matching resolutions alone cannot align a small panel
with a physically larger TV.

## First: load the rendering fix

Reload the editor after deployment. On each Pi, restart its kiosk browser over SSH:

```sh
systemctl --user restart videowall-kiosk
```

Pairing is retained. Existing saved layouts and scene placement are preserved.
The previous player CSS incorrectly capped a spanning image/video to one screen's
size. The player now fits and rotates the full layer in shared wall coordinates,
then clips the correct portion for each screen. This fixes the editor/player crop
mismatch independently of physical calibration.

## Calibrate a physical wall

Use the width and height of the **lit image area**, excluding the frame. The supplied
measurements are **150 mm wide × 85 mm high**. If those measurements included the
frame, measure the lit area again before saving.

1. On the dashboard, select a wall configured for physical layout. Its **Physical wall
   calibration** panel keeps calibration separate from scene content. Existing X/Y
   values are shown but are never assumed to be millimetres or converted automatically.
2. If the wall still has legacy positions, choose **Reset physical positions** and
   confirm. This creates a simple horizontal starting arrangement while retaining every
   measured Width/Height and player viewport. Review it before saving.
3. In each screen's controls, click **Use 150 × 85 mm Pi panel**, or enter the exact
   lit Width and Height in millimetres. The reported player viewport can remain
   800 × 480 px; viewport changes never replace physical measurements.
4. Enter **Left (mm)** and **Top (mm)** for the top-left corner of each lit area,
   measured from the same origin. The top-left panel can be the origin (0, 0).
   You can also drag rectangles in the preview; the numeric values remain the exact
   stored millimetre coordinates.
5. Include the actual distance between lit areas: both frames plus any air gap.
   For a rectangular arrangement with equal gaps, use this table. Substitute your
   measured gaps for `H` and `V`; these are not known from the photos.

   | Panel | Left (mm) | Top (mm) |
   | --- | ---: | ---: |
   | Pi #3, top left | 0 | 0 |
   | Pi #4, top right | 150 + H | 0 |
   | Pi #1, bottom left | 0 | 85 + V |
   | Pi #2, bottom right | 150 + H | 85 + V |

   Type the calculated numbers into the fields, not the formulas. If rows/columns
   are staggered or gaps differ, measure each corner separately.
6. Confirm the derived physical bounds, virtual canvas and virtual px/mm, then click
   **Save physical layout**. Screen geometry belongs to the wall. Existing V2 scenes
   retain their saved canvas/revision and report a mismatch; they are not moved or
   migrated automatically. A new V2 scene uses the newly saved geometry.
7. Open a new V2 scene and select the image layer. Use **Fit layer to selected screens** for a spanning
   image, then choose **Image fit**: **Fill layer (crop edges)** fills the wall bounds;
   **Show whole image** preserves the whole picture and can leave empty space.
   The fit button resets that layer's rotation and scale. You can move or resize it
   afterwards to keep your preferred framing.
8. Click **Save scene**, return to the dashboard, and **Go live** / **Publish** it.

Space behind a frame or between screens is deliberately hidden, as if the image
continued behind it. This keeps a diagonal line straight across the wall. An image
cannot be visible in the physical gaps themselves.

## Add a larger TV

Measure its lit width and height in millimetres. Enter those dimensions and its
physical Left/Top position in the dashboard calibration panel using the same origin
as the Pi panels. Physical mode forces every assigned screen to use millimetres and
does not permit viewport auto-sizing to overwrite its measured footprint.

For example, a hypothetical 600 mm-wide 1920-pixel TV has 3.2 pixels/mm, while the
150 mm-wide 800-pixel Pi panel has about 5.33 pixels/mm. The renderer maps each to
the same physical image coordinates. The TV's real measurements must be used;
1080p does not determine its physical size.

Set each desktop output to its intended resolution. Turn off TV overscan/zoom
(often called Just Scan, Screen Fit, or 1:1) so the complete browser viewport is
visible. For a portrait output, rotate it in Raspberry Pi OS and enter the lit
width/height as mounted. Arbitrary tilted screens and perspective correction are
not supported by the rectangular screen layout.

Test with a still image containing a grid, diagonal lines and circles. Adjust the
measured positions until lines continue across the gaps. Unequal pixel densities
can produce different sharpness; screen brightness/colour and physical alignment
still need adjustment. Browser players do not provide hardware frame-lock, so
perfect video-frame synchronization is a separate limitation.

## Separate concerns

- **Web rendering:** common physical coordinates, media fit, rotation and clipping.
  Existing database fields store these values; no database migration is required.
- **Kiosk startup:** the existing systemd launcher/watchdog handles Chromium
  startup and recovery. See [the kiosk guide](raspberry-pi-kiosk.md).
- **Video compatibility:** a correctly aligned layer can still fail to decode an
  unsupported codec. Use Pi-tested H.264 MP4; calibration does not add AV1 support.
