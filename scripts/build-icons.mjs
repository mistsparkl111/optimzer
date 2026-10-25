// Renders PNG app icons from web/public/icons/icon.svg (run: npm run icons).
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const dir = 'web/public/icons';
const svg = fs.readFileSync(`${dir}/icon.svg`, 'utf8');
const render = (src, size, file) => {
  const png = new Resvg(src, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(`${dir}/${file}`, png);
  console.log(file, png.length);
};
render(svg, 192, 'icon-192.png');
render(svg, 512, 'icon-512.png');
// iOS adds its own rounded mask: use a full-bleed square.
const square = svg.replace('rx="112"', 'rx="0"');
render(square, 180, 'apple-touch-icon.png');
// Maskable: content within the 80% safe zone.
const maskable = square.replace('<g fill="none"', '<g transform="translate(51.2 51.2) scale(0.8)"><g fill="none"').replace('</svg>', '</g></svg>');
render(maskable, 512, 'icon-maskable-512.png');
// Monochrome badge for the Android status bar.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><g fill="none" stroke="#fff" stroke-width="7"><circle cx="48" cy="48" r="38"/><circle cx="48" cy="48" r="18"/></g><path d="M48 48 48 10A38 38 0 0 0 15 29Z" fill="#fff"/><circle cx="66" cy="28" r="7" fill="#fff"/></svg>`;
render(badge, 96, 'badge-96.png');
