export function buildTitle(card) {
  const parts = [
    card.year,
    card.brand,
    card.player,
    card.parallel && card.parallel.toLowerCase() !== "base" ? card.parallel : null,
    card.card_number ? `#${card.card_number}` : null,
    card.serial_number ? `/${card.serial_number.split("/")[1] || card.serial_number}` : null,
    card.is_autograph ? "AUTO" : null,
    card.is_rookie ? "RC" : null,
    card.is_graded && card.grading_company ? `${card.grading_company} ${card.grade || ""}`.trim() : null,
  ].filter(Boolean);

  let title = parts.join(" ");
  if (title.length > 80) title = title.slice(0, 77) + "...";
  return title;
}

export function suggestPrice(comps) {
  if (comps.median_asking_price != null) return { price: comps.median_asking_price, basis: "median" };
  if (comps.avg_asking_price != null) return { price: comps.avg_asking_price, basis: "average" };
  return { price: null, basis: null };
}

export function buildDescription(card, comps) {
  const lines = [];
  lines.push(`${[card.year, card.brand, card.player].filter(Boolean).join(" ")}`);
  if (card.parallel) lines.push(`Parallel: ${card.parallel}`);
  if (card.card_number) lines.push(`Card #: ${card.card_number}`);
  if (card.serial_number) lines.push(`Serial numbered: ${card.serial_number}`);
  lines.push(`Autograph: ${card.is_autograph ? "Yes" : "No"}`);
  lines.push(`Rookie card: ${card.is_rookie ? "Yes" : "No"}`);
  if (card.is_graded) {
    lines.push(`Grade: ${[card.grading_company, card.grade].filter(Boolean).join(" ")}`);
  } else if (card.condition_notes) {
    lines.push(`Condition notes: ${card.condition_notes}`);
  }
  lines.push("");
  lines.push("Ships securely in a top loader / card saver. See photos for exact condition — please zoom in and ask questions before buying.");

  if (comps.listing_count > 0) {
    lines.push("");
    lines.push(
      `(Pricing reference only — not shown to buyers: ${comps.listing_count} comparable active ` +
      `listings found, median asking $${comps.median_asking_price}, range $${comps.min_asking_price}–$${comps.max_asking_price}.)`
    );
  }

  return lines.join("\n");
}

export function buildDraft(card, comps) {
  const { price, basis } = suggestPrice(comps);
  return {
    title: buildTitle(card),
    description: buildDescription(card, comps),
    suggested_price: price,
    price_basis: basis,
  };
}
