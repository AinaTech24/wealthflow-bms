import React from 'react';

interface LogoProps {
  /** Size variant. `compact` for tight rails, `header` for sidebar, `hero` for login. */
  variant?: 'compact' | 'header' | 'hero';
  /** Reserved for future use — currently the full lockup is always shown. */
  withWordmark?: boolean;
  className?: string;
}

/**
 * Freedom LifeX brand mark — the official lockup from freedomlifex.com.
 *
 * Always renders the complete PNG (wings + "Freedom LifeX" wordmark + tagline)
 * exactly as designed, scaled to a comfortable height per variant.
 */
export const Logo: React.FC<LogoProps> = ({ variant = 'header', className = '' }) => {
  const heightClass =
    variant === 'compact' ? 'h-14' :
    variant === 'hero' ? 'h-32 md:h-40' :
    'h-20';  // sidebar header — generous so the wordmark + tagline stay readable

  return (
    <img
      src="/logo.png"
      alt="Freedom LifeX"
      className={`${heightClass} w-auto object-contain select-none ${className}`}
      draggable={false}
    />
  );
};
