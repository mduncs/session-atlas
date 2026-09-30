// Ink golden/layout tests assert terminal cells, not environment-injected ANSI.
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = "1";
