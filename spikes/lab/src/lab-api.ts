import { invoke } from "@tauri-apps/api/core";

export interface LabEnv {
  auto: string | null;
  video: string | null;
  video2: string | null;
  image: string | null;
  viewerPage: string | null;
  manual: string | null;
}

export const labEnv = () => invoke<LabEnv>("lab_env");

export const recordResult = (name: string, data: unknown) =>
  invoke<void>("record_result", { name, json: JSON.stringify(data, null, 2) });

export const exitApp = () => invoke<void>("exit_app");

export const issueFileToken = (path: string) => invoke<string>("issue_file_token", { path });

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const windowGeometry = () => invoke<Geometry>("window_geometry");

export const reloadBegin = () => invoke<void>("reload_begin");

export const reloadReady = () =>
  invoke<{ before: Geometry; after: Geometry; elapsedMs: number }>("reload_ready");
