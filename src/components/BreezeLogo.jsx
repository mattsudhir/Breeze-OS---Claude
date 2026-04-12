export default function BreezeLogo({ size = 40, showText = true, className = '' }) {
  return (
    <div className={`breeze-logo ${className}`} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Circular background */}
        <defs>
          <linearGradient id="breezeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00B4D8" />
            <stop offset="50%" stopColor="#0077B6" />
            <stop offset="100%" stopColor="#023E8A" />
          </linearGradient>
          <linearGradient id="windGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.9)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.4)" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r="56" fill="url(#breezeGrad)" />
        <circle cx="60" cy="60" r="56" stroke="rgba(255,255,255,0.2)" strokeWidth="2" fill="none" />

        {/* Wind / breeze lines */}
        <path d="M25 42 Q50 38, 72 42 Q82 44, 85 38 Q88 32, 80 30" stroke="url(#windGrad)" strokeWidth="4" strokeLinecap="round" fill="none" />
        <path d="M20 58 Q48 52, 78 58 Q90 60, 94 52 Q98 44, 88 42" stroke="url(#windGrad)" strokeWidth="4.5" strokeLinecap="round" fill="none" />
        <path d="M28 74 Q55 68, 82 74 Q92 76, 95 68" stroke="url(#windGrad)" strokeWidth="3.5" strokeLinecap="round" fill="none" />

        {/* Small house icon */}
        <g transform="translate(38, 68) scale(0.7)">
          <path d="M30 10 L5 30 L55 30 Z" fill="white" opacity="0.95" />
          <rect x="10" y="30" width="40" height="25" rx="2" fill="white" opacity="0.9" />
          <rect x="23" y="38" width="14" height="17" rx="1" fill="#0077B6" opacity="0.8" />
          <circle cx="34" cy="47" r="1.5" fill="white" opacity="0.9" />
        </g>
      </svg>
      {showText && (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <span style={{
            fontSize: size * 0.5,
            fontWeight: 700,
            color: '#023E8A',
            letterSpacing: '-0.02em',
            fontFamily: 'Inter, sans-serif'
          }}>
            Breeze
          </span>
          <span style={{
            fontSize: size * 0.25,
            fontWeight: 400,
            color: '#0077B6',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            fontFamily: 'Inter, sans-serif'
          }}>
            Property OS
          </span>
        </div>
      )}
    </div>
  );
}
