import { expect, test, type Page } from "@playwright/test";

async function register(page: Page, username: string) {
  await page.goto("/register");
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill("password1");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByRole("heading", { name: "wekants" })).toBeVisible();
}

async function dragOnto(page: Page, source: ReturnType<Page["locator"]>, target: ReturnType<Page["locator"]>) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) {
    throw new Error("drag target has no box");
  }
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 16, startY + 16, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 40), { steps: 12 });
  await page.mouse.up();
}

async function hangBoard(page: Page, title: string) {
  const bay = page.locator(".workspace").first();
  await bay.getByPlaceholder("新しいボード").fill(title);
  await bay.getByRole("button", { name: "+" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

const stamp = Date.now().toString(36);

test("drag a card to the next list", async ({ page }) => {
  await register(page, `floor1_${stamp}`);
  await hangBoard(page, "Night shift");
  const ready = page.locator(".list").nth(0);
  await ready.getByPlaceholder("新しいカード").fill("Cut plate");
  await ready.getByRole("button", { name: "+" }).click();
  const ticket = page.locator("[data-card-id]").first();
  await expect(ticket).toContainText("Cut plate");
  const doing = page.locator(".list").nth(1);
  await dragOnto(page, ticket, doing.locator(".list-cards"));
  await expect(doing.locator("[data-card-id]")).toContainText("Cut plate");
});

test("second session sees the moved card", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const name = `floor2_${stamp}`;
  await register(a, name);
  await hangBoard(a, "Two benches");
  const ready = a.locator(".list").nth(0);
  await ready.getByPlaceholder("新しいカード").fill("Weld seam");
  await ready.getByRole("button", { name: "+" }).click();
  await expect(a.locator("[data-card-id]")).toContainText("Weld seam");

  const b = await contextB.newPage();
  await b.goto("/login");
  await b.locator('input[name="username"]').fill(name);
  await b.locator('input[name="password"]').fill("password1");
  await b.getByRole("button", { name: "入る" }).click();
  await b.getByRole("link", { name: "Two benches" }).click();
  await expect(b.locator("[data-card-id]")).toContainText("Weld seam");

  const doing = a.locator(".list").nth(1);
  await dragOnto(a, a.locator("[data-card-id]").first(), doing.locator(".list-cards"));
  await expect(doing.locator("[data-card-id]")).toContainText("Weld seam");
  await expect(b.locator(".list").nth(1).locator("[data-card-id]")).toContainText(
    "Weld seam",
  );
  await contextA.close();
  await contextB.close();
});

test("card body renders markdown", async ({ page }) => {
  await register(page, `md_${stamp}`);
  await hangBoard(page, "Spec sheet");
  const ready = page.locator(".list").nth(0);
  await ready.getByPlaceholder("新しいカード").fill("Cut plate");
  await ready.getByRole("button", { name: "+" }).click();
  const ticket = page.locator("[data-card-id]").first();
  await ticket.dblclick();
  await page.locator(".editor textarea").fill("Use **3mm** steel.");
  await page.locator(".editor").getByRole("button", { name: "保存" }).click();
  await expect(ticket.locator("strong")).toHaveText("3mm");
});

test("import a markdown file onto a list", async ({ page }) => {
  await register(page, `file_${stamp}`);
  await hangBoard(page, "Drawings");
  const ready = page.locator(".list").nth(0);
  await ready.getByLabel("未着手 に Markdown を取り込む").setInputFiles({
    name: "cut.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Cut plate\n\nUse **3mm** steel.\n"),
  });
  const ticket = ready.locator("[data-card-id]");
  await expect(ticket).toContainText("Cut plate");
  await expect(ticket.locator("strong")).toHaveText("3mm");
});

test("delete a card from the editor", async ({ page }) => {
  await register(page, `scrap_${stamp}`);
  await hangBoard(page, "Offcuts");
  const ready = page.locator(".list").nth(0);
  await ready.getByPlaceholder("新しいカード").fill("Offcut");
  await ready.getByRole("button", { name: "+" }).click();
  await expect(page.locator("[data-card-id]")).toContainText("Offcut");
  await page.locator("[data-card-id]").first().dblclick();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".editor").getByRole("button", { name: "削除" }).click();
  await expect(page.locator("[data-card-id]")).toHaveCount(0);
});

test("drag a board into another workspace", async ({ page }) => {
  await register(page, `bay_${stamp}`);
  const floor = page.locator(".workspace").first();
  await floor.getByPlaceholder("新しいボード").fill("Jig");
  await floor.getByRole("button", { name: "+" }).click();
  await expect(page.getByRole("heading", { name: "Jig" })).toBeVisible();
  await page.getByRole("link", { name: "すべてのボード" }).click();
  await page.locator('input[name="workspaceTitle"]').fill("Bay 2");
  await page.getByRole("button", { name: "ワークスペースを追加" }).click();
  const bay2 = page.locator(".workspace").filter({ has: page.getByRole("heading", { name: "Bay 2" }) });
  await expect(bay2).toBeVisible();
  await dragOnto(page, page.getByRole("link", { name: "Jig" }), bay2.locator(".workspace-boards"));
  await expect(bay2.getByRole("link", { name: "Jig" })).toBeVisible();
});
