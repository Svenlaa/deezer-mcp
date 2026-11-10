/**
 * Server icon advertised in the MCP initialize handshake (`serverInfo.icons`).
 *
 * A black rounded square with white equalizer bars (Deezer-style). Embedded as
 * a base64 data URI so the server stays self-contained over stdio and HTTP —
 * no hosted asset URL needed.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="110" fill="#0b0b0f"/>
  <g fill="#ffffff">
    <rect x="88" y="288" width="52" height="104" rx="10"/>
    <rect x="168" y="240" width="52" height="152" rx="10"/>
    <rect x="248" y="192" width="52" height="200" rx="10"/>
    <rect x="328" y="256" width="52" height="136" rx="10"/>
  </g>
</svg>`;

export const SERVER_ICON_SRC = `data:image/svg+xml;base64,${Buffer.from(SVG, 'utf8').toString('base64')}`;
