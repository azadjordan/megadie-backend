export async function openOrderTool(page, name) {
  await page.getByRole('button', { name: /^More actions for / }).first().click();
  await page.getByRole('menu').getByRole('menuitem', { name, exact: true }).click();
}
