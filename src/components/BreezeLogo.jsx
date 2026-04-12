// Breeze brand mark shown in the sidebar header. Renders the raster logo
// in /public/breeze-logo.png. Kept as a small wrapper component (rather
// than an inline <img>) so the two display modes — full wordmark vs.
// just the building icon when the sidebar is collapsed — stay in one
// place and the call sites don't need to change.
//
// Props:
//   size     – pixel height of the rendered mark (default 40)
//   showText – true  → full wordmark image
//              false → square crop of the icon portion only (collapsed sidebar)
//   className – optional extra class

const LOGO_SRC = '/breeze-logo.png';

// The source image has the building graphic on the left and the BREEZE
// wordmark on the right. For the collapsed state we show a square window
// into just the left slice of the image. Adjust this if the crop ever
// feels off — it's the only visual knob in the component.
const ICON_CROP_RATIO = 0.32; // fraction of image width that contains the icon

export default function BreezeLogo({ size = 40, showText = true, className = '' }) {
  if (!showText) {
    // Collapsed sidebar: square thumbnail showing only the icon portion.
    // We use background-image + background-size so a single raster asset
    // serves both modes — no second file to keep in sync.
    return (
      <div
        className={`breeze-logo breeze-logo-icon-only ${className}`}
        role="img"
        aria-label="Breeze"
        style={{
          width: size,
          height: size,
          backgroundImage: `url("${LOGO_SRC}")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'left center',
          // Scale the image so its width is size / ICON_CROP_RATIO — that
          // way a `size`-wide window over the left edge shows exactly the
          // icon slice we want.
          backgroundSize: `${Math.round(size / ICON_CROP_RATIO)}px auto`,
        }}
      />
    );
  }

  // Expanded sidebar: full wordmark image. `height` drives everything;
  // the browser preserves aspect ratio automatically.
  return (
    <img
      src={LOGO_SRC}
      alt="Breeze"
      className={`breeze-logo ${className}`}
      style={{
        height: size * 1.1,
        width: 'auto',
        display: 'block',
      }}
    />
  );
}
