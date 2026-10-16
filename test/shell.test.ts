import { expect, test } from "bun:test";
import { MoonsError } from "@moonsjs/core";
import { injectShell } from "@moonsjs/vite/server";

test("injectShell mengisi #root dan menyisipkan payload §17", () => {
  const template = '<!doctype html><html><body><div id="root"></div></body></html>';
  const html = injectShell(template, "<p>halo</p>", "PAYLOAD");

  expect(html).toContain('<div id="root"><p>halo</p></div>');
  expect(html).toContain('<script id="__moons_data" type="application/x-moons">PAYLOAD</script>');
});

test("injectShell dengan meta: title ditimpa + description/og disisipkan (Addendum B.1)", () => {
  const template = "<html><head><title>Lama</title></head><body><div id=\"root\"></div></body></html>";
  const html = injectShell(template, "<p>x</p>", "payload", {
    title: "Halo <Dunia>",
    description: "Deskripsi & uji",
  });

  expect(html).toContain("<title>Halo &lt;Dunia&gt;</title>");
  expect(html).toContain('name="description" content="Deskripsi &amp; uji"');
  expect(html).toContain('property="og:title" content="Halo &lt;Dunia&gt;"');
  expect(html).not.toContain("<title>Lama</title>");

  // Idempoten: apply kedua menimpa, bukan menduplikasi (pakai template asal).
  const again = injectShell(template, "<p>y</p>", "payload", { description: "Baru" });
  expect(again.match(/name="description"/g)?.length).toBe(1);
  expect(again).toContain('content="Baru"');
});

test("injectShell tanpa meta tidak menambah tag", () => {
  const template = "<html><head><title>X</title></head><body><div id=\"root\"></div></body></html>";
  const html = injectShell(template, "<p>x</p>", "payload");
  expect(html).not.toContain('name="description"');
  expect(html).toContain("<title>X</title>");
});

test("injectShell tanpa placeholder → E_INTERNAL dengan saran", () => {
  let thrown: unknown;
  try {
    injectShell("<html><body></body></html>", "x", "y");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MoonsError);
  const error = thrown as MoonsError;
  expect(error.code).toBe("E_INTERNAL");
  expect(error.format()).toContain("Suggestion:");
});
