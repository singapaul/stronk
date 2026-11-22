/** Render web/public/icon.svg to the PNG sizes the PWA manifest and iOS need. Run after editing the SVG. */
import { Resvg } from "@resvg/resvg-js";

const svg = await Bun.file(new URL("../web/public/icon.svg", import.meta.url)).text();
const sizes: [string, number][] = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
];
for (const [name, size] of sizes) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  await Bun.write(new URL(`../web/public/${name}`, import.meta.url), png);
  console.log(`web/public/${name} (${size}px)`);
}
