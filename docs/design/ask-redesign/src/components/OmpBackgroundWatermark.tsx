import React from 'react';

export const OmpBackgroundWatermark: React.FC<{ className?: string }> = ({
  className = '',
}) => {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none select-none overflow-hidden ${className}`}
    >
      <svg
        width="340"
        height="340"
        viewBox="0 0 340 340"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="opacity-35"
      >
        {/* Center isometric core */}
        <polygon points="170,130 205,150 170,170 135,150" fill="#1E2026" />
        <polygon points="135,150 170,170 170,210 135,190" fill="#16181D" />
        <polygon points="205,150 170,170 170,210 205,190" fill="#121318" />

        {/* Upper-left arm */}
        <polygon points="100,90 135,110 100,130 65,110" fill="#1E2026" />
        <polygon points="65,110 100,130 135,190 100,170" fill="#15171C" />
        <polygon points="135,110 170,130 135,150 100,130" fill="#1A1C22" />

        {/* Upper-right arm */}
        <polygon points="240,90 275,110 240,130 205,110" fill="#1E2026" />
        <polygon points="205,110 240,130 205,150 170,130" fill="#1A1C22" />
        <polygon points="275,110 240,130 205,190 240,170" fill="#121418" />

        {/* Bottom vertical column */}
        <polygon points="135,230 170,250 170,305 135,285" fill="#181A20" />
        <polygon points="205,230 170,250 170,305 205,285" fill="#121418" />
        <polygon points="170,210 205,230 170,250 135,230" fill="#1E2026" />
      </svg>
    </div>
  );
};
