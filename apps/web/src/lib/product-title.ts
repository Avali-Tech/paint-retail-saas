/**
 * "Berger WeatherCoat Long Life" from the brand and the product's name, without saying the
 * brand twice when the name already starts with it ("Berger Wall Putty", not "Berger Berger
 * Wall Putty"): catalogues and spreadsheets often name products that way.
 */
export function productTitle(brand: string, product: string): string {
  const prefix = `${brand.toLocaleLowerCase()} `;
  const repeatsBrand =
    product.toLocaleLowerCase() === brand.toLocaleLowerCase() ||
    product.toLocaleLowerCase().startsWith(prefix);
  return repeatsBrand ? product : `${brand} ${product}`;
}
