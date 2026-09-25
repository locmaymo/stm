import { raw } from './html.mjs';

/**
 * The three ports, drawn rather than described.
 *
 * The README says this in Mermaid, which needs a renderer; here it is plain
 * SVG using the theme's own custom properties, so it follows light and dark
 * without a second copy and scales to any column width. The only thing the
 * picture has to carry is that two arrows pass a passcode and one does not,
 * and that nothing outside the box reaches SillyTavern directly.
 */
export function portDiagram(locale) {
  const labels = locale === 'vi'
    ? { machine: 'Máy của bạn', panel: 'Bảng quản trị', gateway: 'Cổng truy cập', silly: 'SillyTavern', you: 'Bạn, trên máy này', lan: 'Điện thoại cùng Wi-Fi', tunnel: 'Cloudflare Tunnel', pass: 'mã truy cập', only: 'chỉ nội bộ' }
    : { machine: 'Your machine', panel: 'Manager panel', gateway: 'Access gateway', silly: 'SillyTavern', you: 'You, on this machine', lan: 'Phone on the same Wi-Fi', tunnel: 'Cloudflare Tunnel', pass: 'passcode', only: 'localhost only' };

  return raw(`<svg viewBox="0 0 420 300" role="img" aria-label="${labels.machine}: 7860, 8001, 8002">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10Z" fill="var(--muted-foreground)"/>
    </marker>
  </defs>
  <g font-family="inherit" font-size="10">
    <rect x="168" y="8" width="244" height="284" rx="14" fill="color-mix(in srgb, var(--primary) 6%, transparent)" stroke="var(--border)" stroke-dasharray="5 4"/>
    <text x="290" y="28" text-anchor="middle" fill="var(--muted-foreground)" font-size="10.5" font-weight="650">${labels.machine}</text>

    <rect x="190" y="42" width="200" height="50" rx="10" fill="var(--card)" stroke="var(--border)"/>
    <text x="206" y="66" fill="var(--foreground)" font-size="11.5" font-weight="620">${labels.panel}</text>
    <text x="206" y="81" fill="var(--muted-foreground)" font-family="monospace">:7860</text>

    <rect x="190" y="122" width="200" height="50" rx="10" fill="var(--card)" stroke="var(--border)"/>
    <text x="206" y="146" fill="var(--foreground)" font-size="11.5" font-weight="620">${labels.gateway}</text>
    <text x="206" y="161" fill="var(--muted-foreground)" font-family="monospace">:8001</text>

    <rect x="190" y="212" width="200" height="54" rx="10" fill="var(--muted)" stroke="var(--border)"/>
    <text x="206" y="236" fill="var(--foreground)" font-size="11.5" font-weight="620">${labels.silly}</text>
    <text x="206" y="251" fill="var(--muted-foreground)" font-family="monospace">:8002 · ${labels.only}</text>

    <!-- The panel reaches SillyTavern directly, so its line goes around the
         gateway rather than through it; drawn through the box it read as the
         panel talking to the gateway, which is the one thing it never does. -->
    <path d="M214 92 214 104 182 104 182 238 190 238" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
    <path d="M348 172 348 212" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>

    <text x="8" y="60" fill="var(--muted-foreground)">${labels.you}</text>
    <path d="M150 66 190 66" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>

    <text x="8" y="132" fill="var(--muted-foreground)">${labels.lan}</text>
    <text x="8" y="196" fill="var(--muted-foreground)">${labels.tunnel}</text>
    <path d="M150 138 170 138 170 147 190 147" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
    <path d="M150 192 170 192 170 154 190 154" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5" marker-end="url(#arrow)"/>
    <text x="118" y="168" text-anchor="middle" fill="var(--attention)" font-size="9.5" font-weight="650">${labels.pass}</text>
  </g>
</svg>`);
}
