import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			adapter: adapter(),
			// Ny deploy skal dukke opp utan at brukaren gjer noko: sida sjekkar versjonen når appen kjem fram igjen.
			version: {
				name: (process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev').slice(0, 7),
				pollInterval: 60_000
			}
		})
	]
});
