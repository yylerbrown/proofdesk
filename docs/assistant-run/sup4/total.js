// Original, copied from ticket SUP-4
function totalOriginal(price, taxRate) {
  return price + price * taxRate + price * taxRate;
}

// Proposed fix: apply tax once
function total(price, taxRate) {
  return price + price * taxRate;
}

module.exports = { total, totalOriginal };
