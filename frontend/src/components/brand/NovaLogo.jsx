import React from 'react';

/**
 * Nova Logo Mark Component
 * Renders the official MedPulse Nova mark using CSS theme variables:
 * - Base rounded container: var(--primary)
 * - Four-point star/spark: var(--primary-light)
 * - Clinical EKG pulse line: var(--primary-contrast)
 */
export const NovaLogo = ({ size = 24, className = '' }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 160 160"
    width={size}
    height={size}
    className={className}
    style={{ minWidth: size, minHeight: size }}
    aria-hidden="true"
  >
    <rect width="160" height="160" rx="40" fill="var(--primary, #159A91)" />
    <path
      d="M80 20 C86 58 102 74 140 80 C102 86 86 102 80 140 C74 102 58 86 20 80 C58 74 74 58 80 20 Z"
      fill="var(--primary-light, #20B8AE)"
    />
    <polyline
      points="22,80 52,80 64,60 80,104 94,70 102,80 138,80"
      fill="none"
      stroke="var(--primary-contrast, #FFFFFF)"
      strokeWidth="6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default NovaLogo;
