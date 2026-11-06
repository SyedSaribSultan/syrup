/** Shared by the server layout and lib/theme.ts (a client module can't hand a plain value to a server component). */
export const THEME_KEY = "syrup.theme"

/** Runs in <head> before first paint, so a saved dark choice never flashes light. Light is the default (no attribute). */
export const THEME_SCRIPT = `try{if(localStorage.getItem("${THEME_KEY}")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`
