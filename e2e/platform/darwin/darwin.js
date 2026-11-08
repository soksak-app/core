// The macOS operations of the window checks.

/** The Text Input Sources identifiers of the input sources that the activation checks select. */
export function inputSources() {
  return Object.freeze({
    latin: "com.apple.keylayout.ABC",
    korean: "com.apple.inputmethod.Korean.2SetKorean",
    japanese: "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese",
  });
}
