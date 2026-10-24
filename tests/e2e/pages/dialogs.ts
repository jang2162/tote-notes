import {
  askUnsaved,
  modal,
  pickLanguage,
  promptText,
  workspacePicker,
} from "../../../src/ui/dialogs";

Object.assign(window, { askUnsaved, promptText, workspacePicker, pickLanguage, modal });
