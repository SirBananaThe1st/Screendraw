// Mirrors the sharer's board onto a transparent canvas covering the display.
const canvas = document.getElementById('canvas');
const board = new Board();

const fit = () => fitCanvas(canvas, board, 0, 0, window.innerWidth, window.innerHeight);
window.addEventListener('resize', fit);
fit();
startRendering(canvas, board);

window.desktop.onBoard((msg) => board.apply(msg));
