import { registerCommands } from "./commands/index.ts";
import { registerHooks, setDirty } from "./hooks/index.ts";
import { registerTools } from "./tools/index.ts";

export default function (pi: ExtensionAPI) {
	const root = () => process.cwd();
	let lastCtx: ExtensionContext | undefined;

	const badge = (s: string) => {
		lastCtx?.ui?.setStatus("kaioken", s);
	};

	registerHooks(
		pi,
		root,
		(s) => badge(s),
		(ctx) => {
			lastCtx = ctx;
		},
	);

	registerTools(pi, root, {
		onVerify: (pass: boolean) => {
			if (pass) {
				setDirty(false);
				badge("verified ✓");
			} else {
				setDirty(true);
				badge("UNVERIFIED CHANGES");
			}
		},
	});

	registerCommands(pi, root);
}
