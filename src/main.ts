import { invoke } from "@tauri-apps/api/core";

void invoke<{ name: string }>("workspace_info").then(
  (info) => {
    document.body.textContent = `tote — ${info.name}`;
  },
  (err: unknown) => {
    document.body.textContent = `tote: ${JSON.stringify(err)}`;
  },
);
