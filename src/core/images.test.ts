import { marked } from "marked";
import { describe, expect, it } from "vitest";

import {
  IMAGE_EXTENSIONS,
  imageLink,
  isImageName,
  MAX_IMAGE_BYTES,
  pastedImageName,
  PASTED_IMAGE_TYPES,
} from "./images";

describe("isImageName", () => {
  it("knows an image by its extension, whatever its case, and nothing else", () => {
    for (const name of ["a.png", "a.JPG", "사진.jpeg", "b.gif", "c.webp", "d.svg", "e.tar.PNG"])
      expect(isImageName(name), name).toBe(true);
    for (const name of ["a.md", "a.heic", "png", ".png", "a.png.txt", "a.pdf", "a"])
      expect(isImageName(name), name).toBe(false);
  });

  it("agrees with the Rust side's list and limit", () => {
    expect(IMAGE_EXTENSIONS).toEqual(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("pastedImageName", () => {
  it("is the memo's name with 이미지 and the extension of the image's type", () => {
    expect(pastedImageName("회의 준비.md", "image/png")).toBe("회의 준비 이미지.png");
    expect(pastedImageName("회의 준비.md", "image/jpeg")).toBe("회의 준비 이미지.jpg");
    expect(pastedImageName("a.markdown", "image/gif")).toBe("a 이미지.gif");
    expect(pastedImageName("untitled.md", "image/webp")).toBe("untitled 이미지.webp");
    expect(Object.keys(PASTED_IMAGE_TYPES)).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
  });
});

/** The `src` the preview's `marked` gives the image, as the viewer decodes it before it asks for
 * the file (viewer.template.html `placeImage`). */
function previewedName(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true });
  const src = /<img src="([^"]*)"/.exec(html)?.[1];
  if (src === undefined) throw new Error(`no image in ${html}`);
  const attribute = src.replace(/&amp;/g, "&");
  try {
    return decodeURIComponent(attribute);
  } catch {
    return attribute;
  }
}

describe("imageLink", () => {
  it("is a plain link for a plain name and an angle-bracket one for spaces or parentheses", () => {
    expect(imageLink("pic.png")).toBe("![](pic.png)");
    expect(imageLink("회의 준비 이미지.png")).toBe("![](<회의 준비 이미지.png>)");
    expect(imageLink("a(1).png")).toBe("![](<a(1).png>)");
    expect(imageLink("100%.png")).toBe("![](100%25.png)");
  });

  it("reads back in the preview as the very name, Korean, spaces, parentheses and % alike", () => {
    for (const name of [
      "pic.png",
      "그림.png",
      "회의 준비 이미지.png",
      "회의 준비 이미지 2.png",
      "a(1).png",
      "a)b.png",
      "a%20b.png",
      "100%.png",
      "a<b>.png",
      "a & b.png",
      "가".normalize("NFD") + " 이미지.png",
    ])
      expect(previewedName(imageLink(name)), name).toBe(name);
  });
});
