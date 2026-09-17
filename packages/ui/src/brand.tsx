import type { ComponentProps, ReactNode } from 'react';
import { cn } from './shadcn/utils.js';

/**
 * The product mark and the third-party marks the console has to point at.
 *
 * A service the operator has to trust with their data - Cloudflare holding the
 * public link, Cloudflare R2 holding the backups - is recognised by its logo
 * long before its name is read, so the cards that configure those services
 * carry the logo rather than another grey outline icon.
 *
 * The service marks are drawn here as SVG so they scale and follow the theme.
 * The product mark is the STVN artwork, which is a raster illustration, so it
 * is an image; `scripts/build-brand-assets.mjs` produces the sizes it is
 * served at.
 */

/** Where the generated brand images are served from, for both dev and a build. */
const BRAND_MARK_SRC = '/brand-mark.png';

export interface BrandMarkProps extends Omit<ComponentProps<'img'>, 'src' | 'alt'> {
  /** Rendered size in pixels. The source is 256px, so anything up to that is sharp. */
  readonly size?: number;
  /** Only the wordmark's own label should name the product; a repeated name is noise. */
  readonly alt?: string;
}

export function BrandMark({ size = 28, className, alt = '', ...props }: BrandMarkProps) {
  return (
    <img
      src={BRAND_MARK_SRC}
      alt={alt}
      width={size}
      height={size}
      decoding="async"
      className={cn('shrink-0 select-none', className)}
      style={{ width: size, height: size }}
      {...(alt === '' ? { 'aria-hidden': true } : {})}
      {...props}
    />
  );
}

export interface BrandLockupProps extends ComponentProps<'span'> {
  readonly size?: number;
  /** Hidden when the sidebar collapses to icons, where the mark stands alone. */
  readonly label?: ReactNode;
}

export function BrandLockup({ size = 28, label = 'ST Manager', className, ...props }: BrandLockupProps) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)} {...props}>
      <BrandMark size={size} />
      <span className="truncate text-[0.9375rem] font-semibold tracking-tight">{label}</span>
    </span>
  );
}

type MarkProps = Omit<ComponentProps<'svg'>, 'viewBox' | 'children'>;

/**
 * Cloudflare.
 *
 * Drawn in the two oranges of the official mark, which is what makes it
 * readable at 16px; the shape is simplified to the cloud body and its wing.
 */
export function CloudflareMark({ className, ...props }: MarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="Cloudflare"
      className={cn('size-5 shrink-0', className)}
      {...props}
    >
      <path
        fill="#fbad41"
        d="M57.6 33.9a10.3 10.3 0 0 0-.7-2.6.9.9 0 0 0-.8-.5l-18.9-.2 3.6-9.1a1 1 0 0 1 .9-.6h.3a13.7 13.7 0 0 1 13.4 10.9 12.9 12.9 0 0 1 2.2 2.1Z"
      />
      <path
        fill="#f6821f"
        d="M43.6 41.4a5.5 5.5 0 0 0-.3-1 7.4 7.4 0 0 0-.3-.9.6.6 0 0 0-.5-.4l-21-.3a.4.4 0 0 1-.3-.2.4.4 0 0 1 0-.4.6.6 0 0 1 .5-.4l21.2-.3a7.5 7.5 0 0 0 7-5l1.3-3.4a.8.8 0 0 0 0-.5A11.9 11.9 0 0 0 28.3 23a9.3 9.3 0 0 0-16 4A7.1 7.1 0 0 0 1.6 34.4a7.9 7.9 0 0 0 .1 1.2.4.4 0 0 0 .4.3h38.7a.5.5 0 0 1 .4.6l-.4 1.6a.6.6 0 0 0 .5.7h1.6a.6.6 0 0 0 .6-.4Z"
      />
      <path
        fill="#f6821f"
        d="M50.9 30.7h-.6a.4.4 0 0 0-.3.3l-.9 3.1a5.5 5.5 0 0 0-.3 1 7.4 7.4 0 0 0-.3.9.6.6 0 0 0 .5.7h8.2a.4.4 0 0 0 .4-.3 9.7 9.7 0 0 0 .3-2.2 6.4 6.4 0 0 0-7-5.9Z"
      />
    </svg>
  );
}

/**
 * Cloudflare R2.
 *
 * The same orange, with the bucket form the storage product is drawn as, so a
 * backup destination is not mistaken for the public link.
 */
export function R2Mark({ className, ...props }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Cloudflare R2"
      className={cn('size-5 shrink-0', className)}
      {...props}
    >
      <ellipse cx="12" cy="5.5" rx="8.5" ry="3" fill="#fbad41" />
      <path
        fill="#f6821f"
        d="M3.5 8.4v3.1c0 1.7 3.8 3 8.5 3s8.5-1.3 8.5-3V8.4c-1.7 1.4-5 2.1-8.5 2.1S5.2 9.8 3.5 8.4Z"
      />
      <path
        fill="#f6821f"
        opacity=".82"
        d="M3.5 14.4v3.1c0 1.7 3.8 3 8.5 3s8.5-1.3 8.5-3v-3.1c-1.7 1.4-5 2.1-8.5 2.1s-6.8-.7-8.5-2.1Z"
      />
    </svg>
  );
}

/** Docker, for the packaging notes and the deployment destinations. */
export function DockerMark({ className, ...props }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Docker"
      className={cn('size-5 shrink-0', className)}
      {...props}
    >
      <path
        fill="#2496ed"
        d="M22.5 9.6c-.5-.4-1.8-.5-2.8-.3-.1-.9-.6-1.7-1.5-2.4l-.5-.4-.4.5c-.5.7-.7 1.8-.6 2.6.1.4.2.8.5 1.1-.2.1-.5.3-.8.4-.6.2-1.2.3-1.9.3H1.2l-.1.4c-.2 1.3 0 2.7.6 3.9.7 1.3 1.8 2.3 3.2 2.8 1.5.6 3.2.9 4.9.9 1.3 0 2.5-.1 3.7-.4a10 10 0 0 0 3.3-1.4 9.1 9.1 0 0 0 2.2-2.3c.6-.9 1-1.9 1.4-3h.3c1.1 0 1.8-.5 2.2-.9.3-.3.5-.6.6-1l.1-.4-.1-.4Z"
      />
      <path fill="#2496ed" d="M3.3 10.3h2.1v-2H3.3v2Zm2.7 0h2.1v-2H6v2Zm2.7 0h2.1v-2H8.7v2Zm2.8 0h2v-2h-2v2Zm-5.5-2.4h2.1V5.8H6v2.1Zm2.7 0h2.1V5.8H8.7v2.1Zm2.8 0h2V5.8h-2v2.1Zm0-2.5h2V3.3h-2v2.1Z" />
    </svg>
  );
}

/**
 * GitHub, for the version channel the installer reads from.
 *
 * GitHub's own path, at the coordinates GitHub publishes it at, rather than a
 * redrawing. The earlier one had every coordinate rounded to a tenth, which at
 * 16px thickened the tail and squared off the ears - recognisable, and visibly
 * not the mark. A logo is either the logo or it is a lookalike.
 */
export function GithubMark({ className, ...props }: MarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="GitHub"
      className={cn('size-5 shrink-0 fill-current', className)}
      {...props}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}
