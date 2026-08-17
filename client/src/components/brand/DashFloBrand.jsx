import React from 'react';
import { useTheme } from '@/lib/theme';

export default function DashFloBrand({
  forceTheme,
  showText = true,
  className = '',
  iconClassName = 'h-9 w-9',
  textClassName = 'text-xl',
}) {
  const { theme } = useTheme();
  const selectedTheme = forceTheme || theme;
  const isDark = selectedTheme === 'dark' || (
    selectedTheme === 'system' &&
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  );
  // The 180px variant. It is the largest size this mark is ever drawn at in the
  // app, including on a 2x display, and it replaced the 1254px original that
  // cost 385KB to render a 36px logo.
  const iconSrc = isDark
    ? '/brand/dashflo-icon-dark-180.png'
    : '/brand/dashflo-icon-light-180.png';

  return (
    <span className={`inline-flex items-center gap-2.5 min-w-0 ${className}`}>
      <img src={iconSrc} alt="" aria-hidden="true" className={`${iconClassName} shrink-0 object-contain`} />
      {showText && (
        <span className={`font-heading font-bold tracking-tight text-foreground whitespace-nowrap ${textClassName}`}>
          Dash<span className="text-primary">Flo</span>
        </span>
      )}
    </span>
  );
}
