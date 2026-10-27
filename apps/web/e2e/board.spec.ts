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

test("a WIP limit blocks a new card and an archived list can return", async ({ page }) => {
  await register(page, `wip_${stamp}`);
  await hangBoard(page, "Queue");
  const ready = page.locator(".list").nth(0);
  const limit = ready.getByLabel("未着手 の WIP");
  await limit.fill("0");
  await limit.press("Enter");
  await expect(ready.getByText("WIP の上限です")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await ready.getByRole("button", { name: "未着手 を保管" }).click();
  await expect(page.locator(".list")).toHaveCount(2);
  await page.getByRole("button", { name: "未着手 を戻す" }).click();
  await expect(page.locator(".list")).toHaveCount(3);
});

test("drag a list before the first list", async ({ page }) => {
  await register(page, `shift_${stamp}`);
  await hangBoard(page, "Bench");
  const doing = page.locator(".list").nth(1);
  const ready = page.locator(".list").nth(0);
  await dragOnto(page, doing.getByRole("button", { name: "着手中 を移動" }), ready);
  await expect(page.locator(".list").nth(0).getByRole("button", { name: "着手中 の名前を変更" })).toBeVisible();
});

test("collapse a list and open it again", async ({ page }) => {
  await register(page, `fold_${stamp}`);
  await hangBoard(page, "Clamp");
  const ready = page.locator(".list").nth(0);
  await ready.getByPlaceholder("新しいカード").fill("Offcut");
  await ready.getByRole("button", { name: "+" }).click();
  await expect(ready.locator("[data-card-id]")).toContainText("Offcut");
  await ready.getByRole("button", { name: "未着手 を折りたたむ" }).click();
  await expect(ready.locator("[data-card-id]")).toHaveCount(0);
  await ready.getByRole("button", { name: "未着手 を開く" }).click();
  await expect(ready.locator("[data-card-id]")).toContainText("Offcut");
});

test("rename a list from its title", async ({ page }) => {
  await register(page, `list_${stamp}`);
  await hangBoard(page, "Saw");
  const ready = page.locator(".list").nth(0);
  await ready.getByRole("button", { name: "未着手 の名前を変更" }).click();
  const field = ready.getByLabel("リスト名");
  await field.fill("切断");
  await field.press("Enter");
  await expect(ready.getByRole("button", { name: "切断 の名前を変更" })).toBeVisible();
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

test("archive a card and restore it", async ({ page }) => {
  await register(page, `drawer_${stamp}`);
  await hangBoard(page, "Drawer");
  const ready = page.locator(".list").nth(0);
  await ready.getByPlaceholder("新しいカード").fill("Spare");
  await ready.getByRole("button", { name: "+" }).click();
  await expect(page.locator("[data-card-id]")).toContainText("Spare");
  await page.locator("[data-card-id]").first().dblclick();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".editor").getByRole("button", { name: "Spare を保管" }).click();
  await expect(page.locator("[data-card-id]")).toHaveCount(0);
  await page.getByRole("button", { name: "Spare を戻す" }).click();
  await expect(page.locator("[data-card-id]")).toContainText("Spare");
});

test("copy a list and a card, and another session sees the card", async ({ page, browser }) => {
  const name = `copy_${stamp}`;
  await register(page, name);
  await hangBoard(page, "Patterns");
  const ready = page.locator(".list").nth(0);
  await ready.getByPlaceholder("新しいカード").fill("Template");
  await ready.getByRole("button", { name: "+" }).click();
  await ready.getByRole("button", { name: "未着手 を複製" }).click();
  await expect(page.getByRole("button", { name: "未着手 の複製 の名前を変更" })).toBeVisible();

  const contextB = await browser.newContext();
  const other = await contextB.newPage();
  await other.goto("/login");
  await other.locator('input[name="username"]').fill(name);
  await other.locator('input[name="password"]').fill("password1");
  await other.getByRole("button", { name: "入る" }).click();
  await other.getByRole("link", { name: "Patterns" }).click();
  await expect(other.locator("[data-card-id]").first()).toContainText("Template");

  await page.locator("[data-card-id]").first().dblclick();
  await page.locator(".editor").getByLabel("複製先のリスト").selectOption({ label: "着手中" });
  await page.locator(".editor").getByRole("button", { name: "Template を複製" }).click();
  await expect(page.locator(".list").nth(1).locator("[data-card-id]")).toContainText("Template の複製");
  await expect(other.locator(".list").nth(1).locator("[data-card-id]")).toContainText("Template の複製");
  await contextB.close();
});

test("drag a workspace before the first workspace", async ({ page }) => {
  await register(page, `order_${stamp}`);
  await page.locator('input[name="workspaceTitle"]').fill("Bay 2");
  await page.getByRole("button", { name: "ワークスペースを追加" }).click();
  const bay2 = page.locator(".workspace").filter({ has: page.getByRole("heading", { name: "Bay 2" }) });
  const first = page.locator(".workspace").first();
  await dragOnto(page, bay2.getByRole("button", { name: "Bay 2 を移動" }), first);
  await expect(page.locator(".workspace").first().getByRole("heading", { name: "Bay 2" })).toBeVisible();
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

test("rename a workspace, search boards, and copy a template", async ({ page }) => {
  await register(page, `shop_${stamp}`);
  const bay = page.locator(".workspace").first();
  await bay.getByRole("heading", { name: "作業場 の名前を変更" }).click();
  const name = bay.getByLabel("ワークスペース名");
  await name.fill("現場");
  await name.press("Enter");
  await expect(bay.getByRole("heading", { name: "現場" })).toBeVisible();
  await bay.getByRole("button", { name: "現場 を星付きにする" }).click();
  await expect(bay.getByRole("button", { name: "現場 の星を外す" })).toBeVisible();
  await bay.getByPlaceholder("新しいボード").fill("Lathe");
  await bay.getByRole("button", { name: "+" }).click();
  await expect(page.getByRole("heading", { name: "Lathe" })).toBeVisible();
  await page.getByRole("button", { name: "雛形にする" }).click();
  await page.getByRole("link", { name: "すべてのボード" }).click();
  await page.getByLabel("ボードを検索").fill("Lathe");
  await expect(page.getByRole("link", { name: /Lathe/ })).toBeVisible();
  await page.getByRole("button", { name: "複製" }).click();
  await expect(page.getByRole("heading", { name: "Lathe の複製" })).toBeVisible();
});

test("create one card with line breaks or many cards from lines", async ({ page }) => {
  await register(page, `lines_${stamp}`);
  await hangBoard(page, "Batch");
  const ready = page.locator(".list").nth(0);
  const field = ready.getByLabel("未着手 の新しいカード");
  await field.fill("Plan\nBuild");
  await ready.getByRole("button", { name: "+" }).click();
  await expect(ready.locator("[data-card-id]")).toHaveCount(1);
  await expect(ready.locator("[data-card-id]")).toContainText("Plan");
  await expect(ready.locator("[data-card-id]")).toContainText("Build");

  await field.fill("Cut\n\nWeld");
  await ready.getByRole("radio", { name: "複数のカード" }).check();
  await ready.getByRole("button", { name: "+" }).click();
  await expect(ready.locator("[data-card-id]")).toHaveCount(3);
  await expect(ready.locator("[data-card-id]").nth(1)).toContainText("Cut");
  await expect(ready.locator("[data-card-id]").nth(2)).toContainText("Weld");
});

test("create many lists from separate lines", async ({ page }) => {
  await register(page, `lists_${stamp}`);
  await hangBoard(page, "Columns");
  await page.getByLabel("新しいリスト").fill("Alpha\nBeta");
  await page.getByRole("radio", { name: "複数のリスト" }).check();
  await page.getByRole("button", { name: "リストを追加" }).click();
  await expect(page.getByRole("button", { name: "Alpha の名前を変更" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Beta の名前を変更" })).toBeVisible();
});

test("create many boards and open the last one", async ({ page }) => {
  await register(page, `boards_${stamp}`);
  const bay = page.locator(".workspace").first();
  await bay.getByLabel("作業場 の新しいボード").fill("One\nTwo");
  await bay.getByRole("radio", { name: "複数のボード" }).check();
  await bay.getByRole("button", { name: "+" }).click();
  await expect(page.getByRole("heading", { name: "Two", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "すべてのボード" }).click();
  await expect(page.getByRole("link", { name: "One" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Two" })).toBeVisible();
});
