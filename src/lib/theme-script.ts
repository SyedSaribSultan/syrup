/** Shared by the server layout and lib/theme.ts (a client module can't hand a plain value to a server component). */
export const THEME_KEY = "syrup.theme"

/** Runs in <head> before first paint, so a saved light/dark choice never flashes the other theme. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`
