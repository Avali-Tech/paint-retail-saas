// English messages shared by the stock and purchasing documents: the product
// picker, reasons and the steps documents move through.

export const workflowEn = {
  picker: {
    label: 'Add a product',
    hint: 'Type a name, brand or SKU, or scan a barcode',
    add: 'Add {sku}',
    noResults: 'No products found',
    notFound: 'No product has the code “{code}”',
    alreadyAdded: '{sku} is already on the list',
    inactive: '{sku} is no longer sold',
  },
  workflow: {
    reason: 'Reason',
    reasonInvalid: 'Give a reason of at least 3 characters',
    remove: 'Remove {sku}',
    noLines: 'Add at least one product',
    quantityInvalid: 'Enter a quantity above zero',
    importData: 'Import from a spreadsheet',
  },
};
