const COUNTY_FILE = "./datasets/rent_income_county_clean.csv";
const STATE_FILE = "./datasets/rent_income_state_clean.csv";
const US_ATLAS_TOPO = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";

const tooltip = d3.select("#tooltip");

let ZIP_DATA = []; // kept only so older helper code does not break; map uses county/state files
let STATE_DATA = [];
let COUNTY_DATA = [];
let US_STATES = null;
let US_COUNTIES = null;
let selectedMapState = "ALL";
let selectedCountyIds = [];
let isAnimatingSalary = false;

let userHasSetSalary = false;
let storyAutoAnimated = false;
let storySalary = 85000;
let isExplorationMode = false;

const stateToFips = {
  "AL":"01","AK":"02","AZ":"04","AR":"05","CA":"06","CO":"08","CT":"09","DE":"10","DC":"11",
  "FL":"12","GA":"13","HI":"15","ID":"16","IL":"17","IN":"18","IA":"19","KS":"20","KY":"21",
  "LA":"22","ME":"23","MD":"24","MA":"25","MI":"26","MN":"27","MS":"28","MO":"29","MT":"30",
  "NE":"31","NV":"32","NH":"33","NJ":"34","NM":"35","NY":"36","NC":"37","ND":"38","OH":"39",
  "OK":"40","OR":"41","PA":"42","RI":"44","SC":"45","SD":"46","TN":"47","TX":"48","UT":"49",
  "VT":"50","VA":"51","WA":"53","WV":"54","WI":"55","WY":"56"
};
const fipsToState = Object.fromEntries(Object.entries(stateToFips).map(([abbr, fips]) => [fips, abbr]));

const warmStates = new Set(["AZ", "CA", "FL", "GA", "HI", "LA", "MS", "NM", "NV", "SC", "TX"]);
const coastalStates = new Set(["AK", "AL", "CA", "CT", "DC", "DE", "FL", "GA", "HI", "LA", "MA", "MD", "ME", "MS", "NC", "NH", "NJ", "NY", "OR", "RI", "SC", "TX", "VA", "WA"]);

function formatDollar(x) {
  if (!isFinite(x)) return "—";
  return "$" + d3.format(",.0f")(x);
}

function formatPercent(x) {
  if (!isFinite(x)) return "—";
  return d3.format(".1f")(x) + "%";
}

function categoryFromBurden(burden) {
  if (burden <= 0.30) return "Affordable";
  if (burden <= 0.40) return "Borderline";
  if (burden <= 0.50) return "Burdened";
  return "Severely burdened";
}

function categoryColor(category) {
  if (category === "Affordable") return "#7dd87d";
  if (category === "Borderline") return "#facc15";
  if (category === "Burdened") return "#fb923c";
  return "#ef4444";
}

function burdenColor(burden) {
  return categoryColor(categoryFromBurden(burden));
}

function normalizeCountyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/'/g, "")
    .replace(/\b(county|parish|borough|census area|municipality|city and borough|city)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function chartFrame(id, customHeight = 560) {
  const el = document.getElementById(id);
  const parent = el.parentElement;
  const parentBox = parent.getBoundingClientRect();
  const styles = window.getComputedStyle(parent);
  const padX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);

  // Measure the real drawable width after the story text shifts and the visual card appears.
  // This fixes the oversized/cut-off charts that happened when SVGs were drawn before
  // the final two-column layout settled.
  let W = Math.max(300, Math.floor((parentBox.width || parent.clientWidth || 360) - padX));

  // Chapter 4 is drawn while the visual card is transitioning in the scrollytelling
  // layout, so the first measurement can come back too small. Give this chart a
  // stable wide canvas so it matches the Chapter 3 comparison chart instead of
  // squeezing into a tiny centered plot.
  if (id === "jobComparisonChart" && !document.body.classList.contains("exploration-unlocked")) {
    const cardBox = el.closest(".visual-card")?.getBoundingClientRect();
    const chapterBox = el.closest(".guided-chapter")?.getBoundingClientRect();
    const cardWidth = cardBox?.width || 0;
    const chapterVisualWidth = chapterBox?.width ? chapterBox.width * 0.66 : 0;
    const viewportVisualWidth = window.innerWidth * 0.58;
    W = Math.max(W, Math.floor(cardWidth - padX), Math.floor(chapterVisualWidth), Math.floor(viewportVisualWidth), 860);
    W = Math.min(W, 1180);
  }

  const guided = !document.body.classList.contains("exploration-unlocked");
  const guidedHeights = {
    mapChart: 410,
    ladderChart: 270,
    comparisonChart: 260,
    jobComparisonChart: 360,
    dreamChart: 210,
    recMapChart: 280
  };
  const explorationHeights = {
    mapChart: 430,
    ladderChart: 285,
    comparisonChart: 260,
    jobComparisonChart: 340,
    dreamChart: 210,
    recMapChart: 300
  };
  const preferredHeight = (guided ? guidedHeights[id] : explorationHeights[id]) || customHeight;
  const viewportLimit = Math.max(260, window.innerHeight - (guided ? 260 : 220));
  const H = Math.max(id === "jobComparisonChart" ? 320 : 200, Math.min(preferredHeight, viewportLimit));

  const svg = d3.select("#" + id)
    .attr("width", W)
    .attr("height", H)
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .html("");
  return { svg, W, H };
}

function cleanData(countyData, stateData, countyFeatures) {
  const validCountyFips = new Set(countyFeatures.map(feature => String(feature.id).padStart(5, "0")));

  stateData.forEach(d => {
    d.avg_monthly_rent = +d.avg_monthly_rent;
    d.avg_annual_income = +d.avg_annual_income;
    d.avg_monthly_income = +d.avg_monthly_income;
    d.local_rent_burden = +d.avg_rent_burden;
    d.local_rent_burden_percent = +d.rent_burden_percent;
    d.zip_count = +d.zip_count || 0;
    d.fips = stateToFips[d.state];
    d.required_income = d.avg_monthly_rent * 12 / 0.30;
  });

  stateData = stateData.filter(d =>
    d.fips &&
    isFinite(d.avg_monthly_rent) &&
    isFinite(d.avg_annual_income) &&
    d.avg_monthly_rent > 0 &&
    d.avg_annual_income > 0
  );

  countyData.forEach(d => {
    d.fips = String(d.fips || "").padStart(5, "0");
    d.state = d.state || fipsToState[d.fips.slice(0, 2)] || "Unknown";
    d.county = d.county || "Unknown County";
    d.avg_monthly_rent = +d.avg_monthly_rent;
    d.avg_annual_income = +d.avg_annual_income;
    d.avg_monthly_income = +d.avg_monthly_income;
    d.local_rent_burden = +d.avg_rent_burden;
    d.local_rent_burden_percent = +d.rent_burden_percent;
    d.zip_count = +d.zip_count || +d.county_count || 1;
    d.required_income = isFinite(+d.required_income)
      ? +d.required_income
      : d.avg_monthly_rent * 12 / 0.30;
    d.label = `${d.county}, ${d.state}`;
  });

  countyData = countyData.filter(d =>
    validCountyFips.has(d.fips) &&
    isFinite(d.avg_monthly_rent) &&
    d.avg_monthly_rent > 0 &&
    isFinite(d.required_income)
  );

  return { zipData: [], stateData, countyData };
}

function withSalary(rows, salary) {
  const monthlyIncome = salary / 12;
  return rows.map(d => {
    const rent = d.avg_monthly_rent || d.monthly_rent;
    const burden = rent / monthlyIncome;
    return {
      ...d,
      salary_rent_burden: burden,
      salary_rent_burden_percent: burden * 100,
      salary_category: categoryFromBurden(burden),
      required_income: rent * 12 / 0.30
    };
  });
}

function setSalary(value, shouldUpdate = true, fromUser = false) {
  const salary = Math.max(30000, Math.min(150000, Math.round(value / 5000) * 5000));

  if (fromUser && isExplorationMode) userHasSetSalary = true;

  const slider = document.getElementById("salarySlider");
  if (slider) slider.value = salary;
  d3.select("#salaryValue").text(salary >= 150000 ? "$150,000+" : formatDollar(salary));
  if (shouldUpdate) updateAll(salary);
}

function updateStats(salaryStateData, salaryCountyData, salary) {
  const affordableStates = salaryStateData.filter(d => d.salary_rent_burden <= 0.30).length;
  const affordableCounties = salaryCountyData.filter(d => d.salary_rent_burden <= 0.30).length;
  const medReq = d3.median(COUNTY_DATA, d => d.required_income);

  d3.select("#affordableStateCount").text(affordableStates);
  d3.select("#affordableCountyCount").text(affordableCounties);
  d3.select("#medianRequiredIncome").text(formatDollar(medReq));
  d3.select("#mapInsight").text(`At ${formatDollar(salary)}, ${affordableStates} states and ${affordableCounties} counties are affordable on average using the 30% rule.`);
}

function drawSalaryMap(stateData, countyData, salary) {
  const { svg, W, H } = chartFrame("mapChart", 560);
  const stateByFips = new Map(stateData.map(d => [d.fips, d]));
  const countyByFips = new Map(countyData.map(d => [d.fips, d]));

  const isCountyMode = selectedMapState !== "ALL";
  const stateFeature = isCountyMode
    ? US_STATES.find(d => String(d.id).padStart(2, "0") === stateToFips[selectedMapState])
    : null;
  const countyFeatures = isCountyMode
    ? US_COUNTIES.filter(d => String(d.id).padStart(5, "0").slice(0, 2) === stateToFips[selectedMapState])
    : [];

  const projection = d3.geoAlbersUsa();
  const fitFeatures = isCountyMode && stateFeature
    ? { type: "FeatureCollection", features: countyFeatures.length ? countyFeatures : [stateFeature] }
    : { type: "FeatureCollection", features: US_STATES };
  projection.fitSize([W - 30, H - 60], fitFeatures);
  const path = d3.geoPath(projection);
  const mapG = svg.append("g").attr("transform", "translate(15, 10)");

  if (!isCountyMode) {
    mapG.selectAll("path")
      .data(US_STATES)
      .enter()
      .append("path")
      .attr("class", "state")
      .attr("d", path)
      .attr("fill", d => {
        const row = stateByFips.get(String(d.id).padStart(2, "0"));
        return row ? burdenColor(row.salary_rent_burden) : "#1f2937";
      })
      .attr("opacity", d => stateByFips.has(String(d.id).padStart(2, "0")) ? 0.95 : 0.35)
      .on("click", (event, d) => {
        if (!isExplorationMode) return;
        const abbr = fipsToState[String(d.id).padStart(2, "0")];
        if (!abbr) return;
        selectedMapState = abbr;
        d3.select("#stateSelect").property("value", abbr);
        updateAll(salary);
      })
      .on("mousemove", (event, d) => {
        const fips = String(d.id).padStart(2, "0");
        const row = stateByFips.get(fips);
        if (!row) return;
        tooltip
          .style("opacity", 1)
          .style("left", event.clientX + 14 + "px")
          .style("top", event.clientY + 14 + "px")
          .html(`
            <strong>${row.state}</strong><br>
            ${isExplorationMode ? "Click to zoom into counties<br>" : "Guided national view<br>"}
            Selected income: ${formatDollar(salary)}<br>
            Monthly income: ${formatDollar(salary / 12)}/mo<br>
            Avg monthly rent: ${formatDollar(row.avg_monthly_rent)}<br>
            Rent burden: ${formatPercent(row.salary_rent_burden_percent)}<br>
            Category: ${row.salary_category}<br>
            Required income: ${formatDollar(row.required_income)}<br>
            Counties included: ${row.zip_count}
          `);
      })
      .on("mouseleave", () => tooltip.style("opacity", 0));

    document.getElementById("mapModeLabel").textContent = "Viewing: all states";
    return;
  }

  mapG.selectAll("path.county")
    .data(countyFeatures)
    .enter()
    .append("path")
    .attr("class", "county")
    .attr("d", path)
    .attr("fill", d => {
      const row = countyByFips.get(String(d.id).padStart(5, "0"));
      return row ? burdenColor(row.salary_rent_burden) : "#1f2937";
    })
    .attr("opacity", d => countyByFips.has(String(d.id).padStart(5, "0")) ? 0.95 : 0.28)
    .on("click", (event, d) => {
      if (!isExplorationMode) return;
      const fips = String(d.id).padStart(5, "0");
      const row = countyByFips.get(fips);
      if (!row) return;
      selectedCountyIds = [fips, ...selectedCountyIds.filter(id => id !== fips)].slice(0, 2);
      syncComparisonDropdowns();
      d3.select("#dreamSelect").property("value", fips);
      drawComparison(salary);
      drawDreamLocation(salary);
    })
    .on("mousemove", (event, d) => {
      const fips = String(d.id).padStart(5, "0");
      const row = countyByFips.get(fips);
      if (!row) return;
      tooltip
        .style("opacity", 1)
        .style("left", event.clientX + 14 + "px")
        .style("top", event.clientY + 14 + "px")
        .html(`
          <strong>${row.county}, ${row.state}</strong><br>
          ${isExplorationMode ? "Click to add to comparison & set dream county<br>" : "County detail<br>"}
          Selected income: ${formatDollar(salary)}<br>
          Monthly income: ${formatDollar(salary / 12)}/mo<br>
          Avg monthly rent: ${formatDollar(row.avg_monthly_rent)}<br>
          Rent burden: ${formatPercent(row.salary_rent_burden_percent)}<br>
          Category: ${row.salary_category}<br>
          Required income: ${formatDollar(row.required_income)}
        `);
    })
    .on("mouseleave", () => tooltip.style("opacity", 0));

  if (stateFeature) {
    mapG.append("path")
      .datum(stateFeature)
      .attr("d", path)
      .attr("fill", "none")
      .attr("stroke", "#fff9ed")
      .attr("stroke-width", 1.25)
      .attr("pointer-events", "none");
  }

  document.getElementById("mapModeLabel").textContent = `Viewing: ${selectedMapState} counties`;
}

function chapter2IncomeSteps(selectedSalary) {
  const base = Math.max(30000, Math.min(150000, Math.round((+selectedSalary || storySalary) / 5000) * 5000));
  const milestoneIncomes = [40000, 60000, 80000, 100000, 150000];
  const upcomingMilestones = milestoneIncomes.filter(income => income > base);

  // Story controls should always begin with the exact salary the user chose,
  // then continue upward through the fixed storytelling milestones.
  return Array.from(new Set([base, ...upcomingMilestones]));
}

function chapter2LadderBars(selectedSalary, currentSalary) {
  const chosen = Math.max(30000, Math.min(150000, Math.round((+selectedSalary || storySalary) / 5000) * 5000));
  const current = Math.max(30000, Math.min(150000, Math.round((+currentSalary || chosen) / 5000) * 5000));

  // The visible chart is the full comparison ladder. It should not shrink just
  // because the guided story starts at a higher salary like $85k.
  return Array.from(new Set([45000, 60000, 80000, 100000, 150000, chosen, current]))
    .filter(income => income >= 30000 && income <= 150000)
    .sort((a, b) => a - b);
}

function drawIncomeLadder(currentSalary) {
  const { svg, W, H } = chartFrame("ladderChart", 310);
  const margin = { top: 70, right: 45, bottom: 50, left: 42 };

  // In guided Chapter 2, keep the full ladder visible while the marker moves
  // through the selected salary's story steps.
  const ladderStartSalary = (!isExplorationMode && storyLadderBaseSalary) ? storyLadderBaseSalary : currentSalary;
  const incomes = chapter2LadderBars(ladderStartSalary, currentSalary);

  const data = incomes.map(income => {
    const rows = withSalary(COUNTY_DATA, income);
    return {
      income,
      share: rows.filter(d => d.salary_rent_burden <= 0.30).length / rows.length
    };
  });

  const x = d3.scaleBand()
    .domain(data.map(d => d.income))
    .range([margin.left, W - margin.right])
    .padding(0.28);

  const y = d3.scaleLinear()
    .domain([0, 1])
    .range([H - margin.bottom, margin.top]);

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${H - margin.bottom})`)
    .call(d3.axisBottom(x).tickFormat(formatDollar));

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".0%")));

  const bars = svg.selectAll("rect")
    .data(data)
    .enter()
    .append("rect")
    .attr("x", d => x(d.income))
    .attr("y", y(0))
    .attr("width", x.bandwidth())
    .attr("height", 0)
    .attr("fill", "#65c7ff")
    .attr("opacity", 0.75);

  bars.transition()
    .duration(isAnimatingSalary ? 850 : 450)
    .ease(d3.easeCubicOut)
    .attr("y", d => y(d.share))
    .attr("height", d => y(0) - y(d.share));

  svg.selectAll("text.value")
    .data(data)
    .enter()
    .append("text")
    .attr("class", "axis-label")
    .attr("x", d => x(d.income) + x.bandwidth() / 2)
    .attr("y", d => y(d.share) - 10)
    .attr("text-anchor", "middle")
    .text(d => d3.format(".0%")(d.share));

  if (currentSalary && isFinite(currentSalary)) {
    const currentShare = withSalary(COUNTY_DATA, currentSalary)
      .filter(d => d.salary_rent_burden <= 0.30).length / COUNTY_DATA.length;

    const nearest = incomes.reduce((a, b) =>
      Math.abs(b - currentSalary) < Math.abs(a - currentSalary) ? b : a
    );

    const markerX = x(nearest) + x.bandwidth() / 2;
    const markerY = y(currentShare);

    svg.append("line")
      .attr("x1", markerX).attr("x2", markerX)
      .attr("y1", margin.top + 5).attr("y2", H - margin.bottom)
      .attr("stroke", "#ffb84d").attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "4,3").attr("opacity", 0.75);

    const marker = svg.append("circle")
      .attr("cx", markerX).attr("cy", markerY).attr("r", 0)
      .attr("fill", "#ffb84d").attr("stroke", "#050711").attr("stroke-width", 1.5);

    marker.transition()
      .duration(isAnimatingSalary ? 650 : 350)
      .attr("r", 6);

    const labelY = Math.max(18, markerY - 55);

    svg.append("text")
      .attr("class", "axis-label marker-label")
      .attr("x", markerX).attr("y", labelY)
      .attr("text-anchor", "middle").attr("fill", "#ffb84d")
      .text(`${d3.format(".0%")(currentShare)} affordable`);

    svg.append("text")
      .attr("class", "axis-label marker-label")
      .attr("x", markerX).attr("y", labelY + 14)
      .attr("text-anchor", "middle").attr("fill", "#ffb84d")
      .text(`${formatDollar(currentSalary)}`);
  }

  if (currentSalary) {
    const share = withSalary(COUNTY_DATA, currentSalary)
      .filter(d => d.salary_rent_burden <= 0.30).length / COUNTY_DATA.length;
    d3.select("#ladderInsight").text(
      `At ${formatDollar(currentSalary)}, ${d3.format(".0%")(share)} of counties are affordable by the 30% rule.`
    );
  }
}

function countyLabel(d) {
  return `${d.county}, ${d.state}`;
}

function currentDreamId() {
  return document.getElementById("introDreamSelect")?.value
      || document.getElementById("dreamSelect")?.value
      || selectedCountyIds[0];
}

function philadelphiaCounty() {
  return COUNTY_DATA.find(d => d.state === "PA" && normalizeCountyName(d.county).includes("philadelphia"));
}

function guidedComparisonPair() {
  const dream = COUNTY_DATA.find(d => d.fips === currentDreamId())
    || COUNTY_DATA.find(d => d.state === "CA" && normalizeCountyName(d.county).includes("san diego"))
    || COUNTY_DATA[0];
  const philly = philadelphiaCounty()
    || COUNTY_DATA.find(d => d.state === "PA")
    || COUNTY_DATA.find(d => d.fips !== dream?.fips)
    || COUNTY_DATA[1];
  return [dream, philly].filter(Boolean);
}

function dreamOfferSalary() {
  // Guided story Chapter 4: compare two concrete job offers.
  return 85000;
}

function lowerPhillyOfferSalary() {
  // Philadelphia offer is intentionally lower than the dream-county offer.
  return 70000;
}

function allanOfferRows() {
  const sanDiego = COUNTY_DATA.find(d => d.state === "CA" && normalizeCountyName(d.county).includes("san diego"));
  const philly = philadelphiaCounty();
  if (!sanDiego || !philly) return null;
  const enrich = (row, salary) => {
    const burden = row.avg_monthly_rent / (salary / 12);
    return {
      row,
      salary,
      burdenPercent: burden * 100,
      label: countyLabel(row)
    };
  };
  return [enrich(sanDiego, dreamOfferSalary()), enrich(philly, lowerPhillyOfferSalary())];
}

function setupOfferGuess() {
  const button = document.getElementById("submitOfferGuess");
  const result = document.getElementById("offerGuessResult");
  if (!button || !result || button.dataset.ready) return;
  button.dataset.ready = "true";

  button.addEventListener("click", () => {
    const offers = allanOfferRows();
    if (!offers) {
      result.textContent = "The offer comparison data is still loading.";
      return;
    }

    const sdGuess = +document.getElementById("guessSanDiego")?.value;
    const phillyGuess = +document.getElementById("guessPhiladelphia")?.value;
    const sd = offers[0];
    const philly = offers[1];
    const guessText = [
      Number.isFinite(sdGuess) ? `Your San Diego guess: ${sdGuess.toFixed(0)}%.` : "No San Diego guess entered.",
      Number.isFinite(phillyGuess) ? `Your Philadelphia guess: ${phillyGuess.toFixed(0)}%.` : "No Philadelphia guess entered."
    ].join(" ");

    result.classList.add("is-revealed");
    result.innerHTML = `${guessText}<br><strong>Actual:</strong> ${sd.label} uses ${formatPercent(sd.burdenPercent)} of Allan’s $85k income for rent. ${philly.label} uses ${formatPercent(philly.burdenPercent)} of his $70k income.`;

    const firstChapter = document.getElementById("chapter4");
    firstChapter?.classList.add("visual-ready", "visual-shown");
    drawJobComparison();
    setTimeout(() => firstChapter?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  });
}

function syncDreamControls(fips) {
  const row = COUNTY_DATA.find(d => d.fips === fips);
  if (!row) return;
  ["#introDreamSelect", "#dreamSelect", "#jobCountyA"].forEach(id => {
    const sel = d3.select(id);
    if (!sel.empty()) sel.property("value", row.fips);
  });
  d3.select("#dreamChoiceNote").text(`Dream county: ${countyLabel(row)}`);
  d3.select("#dreamCountyInline").text(countyLabel(row));
  const philly = philadelphiaCounty();
  selectedCountyIds = [row.fips, philly?.fips || selectedCountyIds[1] || row.fips];
  syncComparisonDropdowns();
  if (philly?.fips) {
    d3.select("#jobCountyB").property("value", philly.fips);
    d3.select("#compareB").property("value", philly.fips);
  }
}

function populateDropdowns() {
  const states = Array.from(new Set(STATE_DATA.map(d => d.state))).sort();
  const stateSelect = d3.select("#stateSelect");
  stateSelect.html("");
  stateSelect.append("option").attr("value", "ALL").text("All states");
  stateSelect.selectAll("option.state-option")
    .data(states).enter().append("option")
    .attr("class", "state-option").attr("value", d => d).text(d => d);

  const prefState = d3.select("#prefState");
  if (!prefState.empty()) {
    prefState.html("");
    prefState.append("option").attr("value", "ALL").text("All states");
    prefState.selectAll("option.pref-state-option")
      .data(states).enter().append("option")
      .attr("class", "pref-state-option").attr("value", d => d).text(d => d);
  }

  const countyOptions = COUNTY_DATA.slice().sort((a, b) => d3.ascending(countyLabel(a), countyLabel(b)));
  ["#compareA", "#compareB", "#dreamSelect", "#introDreamSelect", "#jobCountyA", "#jobCountyB"].forEach(id => {
    const select = d3.select(id);
    if (select.empty()) return;
    select.html("");
    select.selectAll("option")
      .data(countyOptions).enter().append("option")
      .attr("value", d => d.fips).text(d => countyLabel(d));
  });

  const caSanDiego = COUNTY_DATA.find(d => d.state === "CA" && normalizeCountyName(d.county).includes("san diego"));
  const philly = philadelphiaCounty();
  selectedCountyIds = [caSanDiego?.fips, philly?.fips].filter(Boolean);
  if (selectedCountyIds.length < 2) selectedCountyIds = countyOptions.slice(0, 2).map(d => d.fips);
  syncComparisonDropdowns();
  if (selectedCountyIds[0]) syncDreamControls(selectedCountyIds[0]);

  if (selectedCountyIds[0]) d3.select("#jobCountyA").property("value", selectedCountyIds[0]);
  if (selectedCountyIds[1]) d3.select("#jobCountyB").property("value", selectedCountyIds[1]);

  const salaryOptions = Array.from({ length: (150000 - 30000) / 5000 + 1 }, (_, i) => 30000 + i * 5000);
  ["#jobSalaryA", "#jobSalaryB"].forEach((id, idx) => {
    const sel = d3.select(id).html("");
    salaryOptions.forEach(s => sel.append("option").attr("value", s).text(formatDollar(s)));
    d3.select(id).property("value", idx === 0 ? 75000 : 60000);
  });
}

function syncComparisonDropdowns() {
  if (selectedCountyIds[0]) d3.select("#compareA").property("value", selectedCountyIds[0]);
  if (selectedCountyIds[1]) d3.select("#compareB").property("value", selectedCountyIds[1]);
}

function drawComparison(salary) {
  if (!document.getElementById("comparisonCards") || !document.getElementById("comparisonChart")) return;
  if (!isExplorationMode) {
    const pair = guidedComparisonPair();
    selectedCountyIds = pair.map(d => d.fips);
    syncComparisonDropdowns();
  } else {
    selectedCountyIds = [document.getElementById("compareA").value, document.getElementById("compareB").value];
  }
  const rows = selectedCountyIds.map(id => COUNTY_DATA.find(d => d.fips === id)).filter(Boolean);
  const salaryRows = withSalary(rows, salary);

  const cards = d3.select("#comparisonCards").html("");
  cards.selectAll("div").data(salaryRows).enter().append("div").attr("class", "place-card")
    .html(d => `
      <h4>${countyLabel(d)}</h4>
      <p>Rent: ${formatDollar(d.avg_monthly_rent)} / month</p>
      <p>Rent burden: ${formatPercent(d.salary_rent_burden_percent)}</p>
      <p>Required income: ${formatDollar(d.required_income)}</p>
      <p>Category: ${d.salary_category}</p>
    `);

  const { svg, W, H } = chartFrame("comparisonChart", 260);
  if (salaryRows.length === 0) return;
  const margin = { top: 24, right: 20, bottom: 55, left: 48 };
  const x = d3.scaleBand().domain(salaryRows.map(countyLabel)).range([margin.left, W - margin.right]).padding(0.35);
  const yMax = Math.max(60, d3.max(salaryRows, d => d.salary_rent_burden_percent) * 1.2);
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([H - margin.bottom, margin.top]);

  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - margin.bottom})`)
    .call(d3.axisBottom(x)).selectAll("text").attr("transform", "rotate(-12)").style("text-anchor", "end");
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d => d + "%"));

  svg.append("line")
    .attr("x1", margin.left).attr("x2", W - margin.right)
    .attr("y1", y(30)).attr("y2", y(30))
    .attr("stroke", "#ffb84d").attr("stroke-dasharray", "5,4");
  svg.append("text").attr("class", "axis-label")
    .attr("x", W - margin.right).attr("y", y(30) - 6)
    .attr("text-anchor", "end").text("30% affordable line");

  svg.selectAll("rect").data(salaryRows).enter().append("rect")
    .attr("x", d => x(countyLabel(d)))
    .attr("y", d => y(d.salary_rent_burden_percent))
    .attr("width", x.bandwidth())
    .attr("height", d => y(0) - y(d.salary_rent_burden_percent))
    .attr("fill", d => burdenColor(d.salary_rent_burden))
    .attr("opacity", 0.9);

  // Match Chapter 4: show the exact rent-burden percentage above each bar.
  svg.selectAll(".bar-value").data(salaryRows).enter().append("text")
    .attr("class", "bar-value")
    .attr("x", d => x(countyLabel(d)) + x.bandwidth() / 2)
    .attr("y", d => y(d.salary_rent_burden_percent) - 8)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--ink)")
    .attr("font-weight", "800")
    .attr("font-size", "13px")
    .text(d => formatPercent(d.salary_rent_burden_percent));
}

function drawJobComparison() {
  if (!isExplorationMode) {
    const pair = guidedComparisonPair();
    if (pair[0]) d3.select("#jobCountyA").property("value", pair[0].fips);
    if (pair[1]) d3.select("#jobCountyB").property("value", pair[1].fips);
    d3.select("#jobSalaryA").property("value", dreamOfferSalary());
    d3.select("#jobSalaryB").property("value", lowerPhillyOfferSalary());
  }
  const countyAId = document.getElementById("jobCountyA").value;
  const countyBId = document.getElementById("jobCountyB").value;
  const salaryA = Math.max(0, +document.getElementById("jobSalaryA").value || 0);
  const salaryB = Math.max(0, +document.getElementById("jobSalaryB").value || 0);

  const rowA = COUNTY_DATA.find(d => d.fips === countyAId);
  const rowB = COUNTY_DATA.find(d => d.fips === countyBId);
  if (!rowA || !rowB) return;

  const enrich = (row, salary) => {
    const rent = row.avg_monthly_rent;
    const burden = salary > 0 ? rent / (salary / 12) : Infinity;
    return {
      ...row,
      job_salary: salary,
      salary_rent_burden: burden,
      salary_rent_burden_percent: burden * 100,
      salary_category: categoryFromBurden(burden),
      required_income: rent * 12 / 0.30
    };
  };

  const salaryRows = [enrich(rowA, salaryA), enrich(rowB, salaryB)];
  const labels = salaryRows.map(countyLabel);

  const cards = d3.select("#jobComparisonCards").html("");
  cards.selectAll("div").data(salaryRows).enter().append("div").attr("class", "place-card offer-card")
    .html(d => `
      <h4>${countyLabel(d)}</h4>
      <p>Salary: ${formatDollar(d.job_salary)}/yr</p>
      <p>Rent: ${formatDollar(d.avg_monthly_rent)} / month</p>
      <p>Rent burden: ${formatPercent(d.salary_rent_burden_percent)}</p>
      <p>Required income: ${formatDollar(d.required_income)}</p>
      <p>Category: ${d.salary_category}</p>
    `);

  const { svg, W, H } = chartFrame("jobComparisonChart", 430);
  const margin = { top: 34, right: 76, bottom: 72, left: 64 };
  const x = d3.scaleBand().domain(labels).range([margin.left, W - margin.right]).padding(0.42);
  const yMax = Math.max(60, d3.max(salaryRows, d => isFinite(d.salary_rent_burden_percent) ? d.salary_rent_burden_percent : 0) * 1.2);
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([H - margin.bottom, margin.top]);

  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - margin.bottom})`)
    .call(d3.axisBottom(x))
    .selectAll("text")
    .attr("transform", "rotate(-12)")
    .style("text-anchor", "end")
    .style("font-size", "12px");

  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d => d + "%"));

  svg.append("line")
    .attr("x1", margin.left).attr("x2", W - margin.right)
    .attr("y1", y(30)).attr("y2", y(30))
    .attr("stroke", "#ffb84d").attr("stroke-dasharray", "5,4");
  svg.append("text").attr("class", "axis-label")
    .attr("x", W - margin.right).attr("y", y(30) - 6)
    .attr("text-anchor", "end").text("30% affordable line");

  svg.selectAll("rect").data(salaryRows).enter().append("rect")
    .attr("x", (d, i) => x(labels[i]))
    .attr("y", d => y(Math.min(isFinite(d.salary_rent_burden_percent) ? d.salary_rent_burden_percent : yMax, yMax)))
    .attr("width", x.bandwidth())
    .attr("height", d => {
      const val = isFinite(d.salary_rent_burden_percent) ? Math.min(d.salary_rent_burden_percent, yMax) : yMax;
      return y(0) - y(val);
    })
    .attr("fill", d => isFinite(d.salary_rent_burden) ? burdenColor(d.salary_rent_burden) : "#c0302a")
    .attr("opacity", 0.88);

  svg.selectAll(".bar-value").data(salaryRows).enter().append("text")
    .attr("class", "bar-value")
    .attr("x", (d, i) => x(labels[i]) + x.bandwidth() / 2)
    .attr("y", d => y(Math.min(isFinite(d.salary_rent_burden_percent) ? d.salary_rent_burden_percent : yMax, yMax)) - 8)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--ink)")
    .attr("font-weight", "800")
    .attr("font-size", "13px")
    .text(d => formatPercent(d.salary_rent_burden_percent));
}

function drawDreamLocation(salary) {
  const id = currentDreamId();
  const row = COUNTY_DATA.find(d => d.fips === id);
  if (!row) return;

  const requiredIncome = row.required_income;
  const burden = row.avg_monthly_rent / (salary / 12);
  d3.select("#dreamTitle").text(countyLabel(row));
  d3.select("#dreamRequiredIncome").text(formatDollar(requiredIncome));
  d3.select("#dreamDetails").text(`At ${formatDollar(salary)}, housing would take ${formatPercent(burden * 100)} of income. The 30% rule requires about ${formatDollar(requiredIncome)}/yr.`);

  const { svg, W, H } = chartFrame("dreamChart", 210);
  const margin = { top: 25, right: 20, bottom: 35, left: 36 };
  const data = [
    { label: "Your salary", value: salary },
    { label: "Needed", value: requiredIncome }
  ];
  const x = d3.scaleBand().domain(data.map(d => d.label)).range([margin.left, W - margin.right]).padding(0.35);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.value) * 1.2]).nice().range([H - margin.bottom, margin.top]);

  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - margin.bottom})`).call(d3.axisBottom(x));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(formatDollar));
  svg.selectAll("rect").data(data).enter().append("rect")
    .attr("x", d => x(d.label))
    .attr("y", d => y(d.value))
    .attr("width", x.bandwidth())
    .attr("height", d => y(0) - y(d.value))
    .attr("fill", d => d.label === "Your salary" ? "#65c7ff" : "#ffb84d")
    .attr("opacity", 0.82);
}

const midwestStates = new Set(["IA","IL","IN","KS","MI","MN","MO","ND","NE","OH","SD","WI"]);

function updateRecommendations(salary) {
  const warm    = document.getElementById("prefWarm").checked;
  const coastal = document.getElementById("prefCoastal").checked;
  const midwest = document.getElementById("prefMidwest") && document.getElementById("prefMidwest").checked;
  const urban   = document.getElementById("prefUrban").checked;
  const lowRent = document.getElementById("prefLowRent") && document.getElementById("prefLowRent").checked;
  const buffer  = document.getElementById("prefBuffer") && document.getElementById("prefBuffer").checked;
  const prefStateEl = document.getElementById("prefState");
  const stateFilter = prefStateEl ? prefStateEl.value : "ALL";

  const medianZips = d3.median(COUNTY_DATA, r => r.zip_count);

  let rows = withSalary(COUNTY_DATA, salary)
    .filter(d => d.salary_rent_burden <= 0.30)
    .filter(d => stateFilter === "ALL" || d.state === stateFilter)
    .filter(d => !warm    || warmStates.has(d.state))
    .filter(d => !coastal || coastalStates.has(d.state))
    .filter(d => !midwest || midwestStates.has(d.state))
    .filter(d => !urban   || d.zip_count >= medianZips)
    .filter(d => !lowRent || d.avg_monthly_rent < 1200)
    .filter(d => !buffer  || d.salary_rent_burden <= 0.20)
    .sort((a, b) => d3.ascending(a.salary_rent_burden, b.salary_rent_burden))
    .slice(0, 6);

  const list = d3.select("#recommendationList").html("");
  if (rows.length === 0) {
    list.append("p").style("font-size","0.8rem").style("color","var(--muted)").style("padding","0.5rem 0")
      .text("No counties match these filters at the selected salary. Try raising income or removing a filter.");
    drawRecMap([]);
    return;
  }

  list.selectAll("div").data(rows).enter().append("div").attr("class", "recommendation-item")
    .html((d, i) => `
      <h4>${i + 1}. ${countyLabel(d)}</h4>
      <p>Burden: <strong style="color:var(--teal2)">${formatPercent(d.salary_rent_burden_percent)}</strong> &nbsp;·&nbsp; Rent: ${formatDollar(d.avg_monthly_rent)}/mo</p>
      <p>Need: ${formatDollar(d.required_income)}/yr</p>
    `);

  drawRecMap(rows);
}

function drawRecMap(matchedRows) {
  if (!US_STATES || !US_COUNTIES) return;
  const el = document.getElementById("recMapChart");
  if (!el) return;

  const parent = el.parentElement;
  const parentBox = parent.getBoundingClientRect();
  const styles = window.getComputedStyle(parent);
  const padX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
  const W = Math.max(280, Math.floor((parentBox.width || parent.clientWidth || 320) - padX));
  const H = document.body.classList.contains("exploration-unlocked") ? 300 : 280;
  const svg = d3.select("#recMapChart")
    .attr("height", H)
    .attr("width", W)
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .html("");

  const matchedFips = new Set(matchedRows.map(d => d.fips));

  const projection = d3.geoAlbersUsa();
  projection.fitSize([W, H], { type: "FeatureCollection", features: US_STATES });
  const path = d3.geoPath(projection);

  svg.append("g").selectAll("path").data(US_STATES).enter().append("path")
    .attr("d", path).attr("fill", "#d8e6ee").attr("stroke", "white").attr("stroke-width", 0.5);

  svg.append("g").selectAll("path")
    .data(US_COUNTIES.filter(d => matchedFips.has(String(d.id).padStart(5, "0"))))
    .enter().append("path")
    .attr("d", path).attr("fill", "#FC8A10").attr("stroke", "white").attr("stroke-width", 0.8).attr("opacity", 0.9)
    .on("mousemove", (event, d) => {
      const fips = String(d.id).padStart(5, "0");
      const row = matchedRows.find(r => r.fips === fips);
      if (!row) return;
      tooltip.style("opacity", 1)
        .style("left", event.clientX + 14 + "px").style("top", event.clientY + 14 + "px")
        .html(`<strong>${countyLabel(row)}</strong>Rent: ${formatDollar(row.avg_monthly_rent)}/mo<br>Burden: ${formatPercent(row.salary_rent_burden_percent)}`);
    })
    .on("mouseleave", () => tooltip.style("opacity", 0));

  matchedRows.forEach((row, i) => {
    const feature = US_COUNTIES.find(d => String(d.id).padStart(5, "0") === row.fips);
    if (!feature) return;
    const centroid = path.centroid(feature);
    if (!centroid || !isFinite(centroid[0])) return;
    svg.append("circle").attr("cx", centroid[0]).attr("cy", centroid[1]).attr("r", 8)
      .attr("fill", "#FC8A10").attr("stroke", "white").attr("stroke-width", 1.5);
    svg.append("text").attr("x", centroid[0]).attr("y", centroid[1] + 4)
      .attr("text-anchor", "middle").attr("fill", "white").attr("font-size", 9).attr("font-weight", "700")
      .text(i + 1);
  });
}

function updateAll(salary) {
  selectedMapState = document.getElementById("stateSelect").value;
  const salaryStateData = withSalary(STATE_DATA, salary);
  const salaryCountyData = withSalary(COUNTY_DATA, salary);

  d3.select("#salaryValue").text(salary >= 150000 ? "$150,000+" : formatDollar(salary));
  updateStats(salaryStateData, salaryCountyData, salary);
  drawSalaryMap(salaryStateData, salaryCountyData, salary);
  drawIncomeLadder(salary);
  drawComparison(salary);
  drawDreamLocation(salary);
  updateRecommendations(salary);
  updatePersonalSummary(salary);
}

function updateStorySalaryText() {
  d3.select("#storySalaryInline").text(storySalary >= 150000 ? "$150,000+" : formatDollar(storySalary));
  d3.select("#salaryChoiceNote").text(`Selected story salary: ${storySalary >= 150000 ? "$150,000+" : formatDollar(storySalary)}`);
  d3.select("#summarySalary").text(storySalary >= 150000 ? "$150,000+" : formatDollar(storySalary));
}

function storyCareerSalary() {
  return Math.min(150000, Math.max(storySalary + 25000, Math.round(storySalary * 1.25 / 5000) * 5000));
}

function salaryForSection(section) {
  if (!section) return +document.getElementById("salarySlider").value || storySalary;
  if (section.dataset.useCareerSalary) return storyCareerSalary();
  if (section.dataset.useStorySalary) return storySalary;
  const salary = +section.dataset.salary;
  return salary || storySalary;
}

function updateGuidedDefaults() {
  updateStorySalaryText();
  if (!COUNTY_DATA.length) return;
  const caSanDiego = COUNTY_DATA.find(d => d.state === "CA" && normalizeCountyName(d.county).includes("san diego"));
  const dreamId = currentDreamId() || caSanDiego?.fips || selectedCountyIds[0];
  const dream = COUNTY_DATA.find(d => d.fips === dreamId) || caSanDiego || COUNTY_DATA[0];
  const philly = philadelphiaCounty() || COUNTY_DATA.find(d => d.state === "PA") || COUNTY_DATA.find(d => d.fips !== dream?.fips);

  selectedCountyIds = [dream?.fips, philly?.fips].filter(Boolean);
  if (selectedCountyIds.length < 2) selectedCountyIds = COUNTY_DATA.slice(0, 2).map(d => d.fips);
  syncComparisonDropdowns();

  if (dream?.fips) {
    syncDreamControls(dream.fips);
    d3.select("#jobCountyA").property("value", dream.fips);
  }
  if (philly?.fips) {
    d3.select("#jobCountyB").property("value", philly.fips);
    d3.select("#compareB").property("value", philly.fips);
  }
  d3.select("#jobSalaryA").property("value", dreamOfferSalary());
  d3.select("#jobSalaryB").property("value", lowerPhillyOfferSalary());
  drawJobComparison();
}

function updatePersonalSummary(salary) {
  if (!COUNTY_DATA.length) return;
  const salaryRows = withSalary(COUNTY_DATA, salary);
  const affordableCount = salaryRows.filter(d => d.salary_rent_burden <= 0.30).length;
  const share = affordableCount / salaryRows.length;
  d3.select("#summarySalary").text(salary >= 150000 ? "$150,000+" : formatDollar(salary));
  d3.select("#summaryAffordableShare").text(`${d3.format(".0%")(share)} (${affordableCount} counties)`);

  const dreamId = currentDreamId();
  const dream = COUNTY_DATA.find(d => d.fips === dreamId);
  if (dream) {
    const gap = dream.required_income - salary;
    const text = gap <= 0 ? `${formatDollar(Math.abs(gap))} under budget` : `${formatDollar(gap)} more needed`;
    d3.select("#summaryDreamGap").text(text);
  }
}

function enterExplorationMode() {
  storyLadderBaseSalary = storySalary;
  isExplorationMode = true;
  userHasSetSalary = true;
  document.body.classList.add("exploration-unlocked");
  document.body.classList.remove("exploration-ready");
  const badge = document.getElementById("modeBadge");
  if (badge) badge.textContent = "Full exploration mode";
  setSalary(storySalary, true, true);
  const ladderStatus = document.getElementById("incomeAnimationStatus");
  if (ladderStatus) ladderStatus.textContent = "Use the salary buttons to compare income levels.";
  redrawAfterLayoutShift(120);
  redrawAfterLayoutShift(520);
  setTimeout(() => document.getElementById("chapter1")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
}

function setupStoryReveals() {
  const selectors = [
    '.story-copy .eyebrow', '.story-copy h2', '.story-copy > p', '.story-question', '.formula-card',
    '.chapter-text .eyebrow', '.chapter-text h2', '.chapter-text > p', '.chapter-prompt', '.use-note',
    '.stat-grid', '.salary-buttons', '.mini-controls', '.pref-section',
    '.visual-card > h3', '.dream-card .big-number', '.dream-card > p', '.story-action-button',
    '.takeaway-card', '.reflection-copy .eyebrow', '.reflection-copy h2', '.reflection-copy p',
    '.story-setup-panel', '.salary-choice', '.intro-dream-control', '.personal-summary-card', '.explore-button', '.explore-checklist div'
  ].join(', ');

  document.querySelectorAll('.story-section, .chapter').forEach(section => {
    let index = 0;
    section.querySelectorAll(selectors).forEach(el => {
      if (el.classList.contains('story-reveal')) return;
      el.classList.add('story-reveal');
      el.style.setProperty('--reveal-index', index++);
    });
  });
}

let visualRevealTimer = null;

function updateStoryChrome(activeSection) {
  document.querySelectorAll(".story-section.is-active, .chapter.is-active").forEach(section => {
    section.classList.remove("is-active");
  });
  activeSection.classList.add("is-active", "reveal-done");
  if (activeSection.classList.contains("visual-shown")) {
    activeSection.classList.add("visual-ready");
  }

  clearTimeout(visualRevealTimer);
  // In guided mode, visuals do not appear automatically anymore.
  // The reader controls the pacing with the Show visual / Next button so they have time to read.
  if (!activeSection.classList.contains("guided-chapter") || isExplorationMode) {
    visualRevealTimer = setTimeout(() => activeSection.classList.add("visual-ready", "visual-shown"), 250);
  }
  updateStoryActionButtons(activeSection);
  const step = activeSection.dataset.storyStep;
  document.querySelectorAll(".story-progress a").forEach(link => link.classList.remove("active"));

  if (activeSection.id) {
    const direct = document.querySelector(`.story-progress a[href="#${activeSection.id}"]`);
    if (direct) direct.classList.add("active");
  }

  const badge = document.getElementById("modeBadge");
  if (badge) {
    if (isExplorationMode) badge.textContent = "Full exploration mode";
    else if (activeSection.dataset.unlockExploration) badge.textContent = "Ready for exploration";
    else badge.textContent = "Guided story mode";
  }

  document.body.classList.toggle("exploration-ready", !!activeSection.dataset.unlockExploration && !isExplorationMode);
}

let storyLadderStepIndex = 0;
let storyLadderBaseSalary = storySalary;
const storyLadderSteps = () => chapter2IncomeSteps(storyLadderBaseSalary);

function setupStoryLadderControls() {
  const box = document.getElementById("storyLadderControls");
  if (!box || box.dataset.ready) return;
  box.dataset.ready = "true";
  const back = box.querySelector("[data-ladder='back']");
  const next = box.querySelector("[data-ladder='next']");
  const reset = box.querySelector("[data-ladder='reset']");
  if (back) back.addEventListener("click", () => stepStoryLadder(-1));
  if (next) next.addEventListener("click", () => stepStoryLadder(1));
  if (reset) reset.addEventListener("click", () => { storyLadderStepIndex = 0; applyStoryLadderStep(); });
}

function applyStoryLadderStep() {
  if (!storyLadderBaseSalary) storyLadderBaseSalary = storySalary;
  const steps = storyLadderSteps();
  storyLadderStepIndex = Math.max(0, Math.min(storyLadderStepIndex, steps.length - 1));
  const salary = steps[storyLadderStepIndex];
  const status = document.getElementById("incomeAnimationStatus");
  if (status) {
    status.classList.remove("is-animating");
    status.textContent = `Viewing income: ${salary >= 150000 ? "$150,000+" : formatDollar(salary)}.`;
  }
  const box = document.getElementById("storyLadderControls");
  if (box) {
    const back = box.querySelector("[data-ladder='back']");
    const next = box.querySelector("[data-ladder='next']");
    if (back) back.disabled = storyLadderStepIndex === 0;
    if (next) next.disabled = storyLadderStepIndex === steps.length - 1;
  }
  setSalary(salary, true, false);
}

function stepStoryLadder(direction) {
  storyLadderStepIndex += direction;
  applyStoryLadderStep();
}

const visualButtonLabels = {
  chapter1: "Show map",
  chapter2: "Show income ladder",
  chapter4: "Show Allan’s offer comparison",
  chapter5: "Show dream county result",
  chapter6: "Show recommendations"
};

function redrawAfterLayoutShift(delay = 120) {
  window.setTimeout(() => {
    const slider = document.getElementById("salarySlider");
    const salary = slider ? +slider.value : storySalary;
    updateAll(salary);
  }, delay);
}

function setupGuidedActionButtons() {
  document.querySelectorAll(".guided-chapter").forEach(section => {
    const text = section.querySelector(".chapter-text");
    if (!text || text.querySelector(".story-action-button")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "story-action-button guided-copy";
    btn.textContent = visualButtonLabels[section.id] || "Show visual";
    btn.addEventListener("click", () => handleStoryAction(section));
    text.appendChild(btn);
  });
}

function updateStoryActionButtons(activeSection) {
  document.querySelectorAll(".story-action-button").forEach(btn => {
    const section = btn.closest(".guided-chapter");
    if (!section) return;
    btn.textContent = visualButtonLabels[section.id] || "Show visual";
    btn.disabled = section.classList.contains("visual-ready");
    btn.hidden = section.classList.contains("visual-ready");
  });
}

function nextStorySection(section) {
  const sections = Array.from(document.querySelectorAll("#charts > .chapter, #charts > .story-section"));
  const idx = sections.indexOf(section);
  return idx >= 0 ? sections[idx + 1] : null;
}

function handleStoryAction(section) {
  if (isExplorationMode) return;
  if (!section.classList.contains("visual-ready")) {
    section.classList.add("visual-ready", "visual-shown");
    const btn = section.querySelector(".story-action-button");
    if (btn) { btn.hidden = true; btn.disabled = true; }
    if (section.id === "chapter2") {
      storyLadderStepIndex = 0;
      setTimeout(() => { setupStoryLadderControls(); applyStoryLadderStep(); }, 180);
    }
    redrawAfterLayoutShift(80);
    redrawAfterLayoutShift(420);
  }
}

function setupScrollStory() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      updateStoryChrome(entry.target);

      const salary = salaryForSection(entry.target);
      if (salary && !isAnimatingSalary && !isExplorationMode) setSalary(salary, true, false);

      // Chapter 2 animation starts when the reader clicks the visual button.
    });
  }, { threshold: 0.32, rootMargin: "-12% 0px -28% 0px" });

  document.querySelectorAll(".story-section, .chapter").forEach(section => observer.observe(section));
}

async function animateSalary() {
  if (isAnimatingSalary) return;
  isAnimatingSalary = true;
  userHasSetSalary = true;
  const button = document.getElementById("playSalaryButton");
  button.textContent = "Animating...";
  const steps = Array.from({ length: (150000 - 30000) / 5000 + 1 }, (_, i) => 30000 + i * 5000);
  for (const salary of steps) {
    setSalary(salary, true, true);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  button.textContent = "Animate income";
  isAnimatingSalary = false;
}

Promise.all([
  d3.csv(COUNTY_FILE),
  d3.csv(STATE_FILE),
  d3.json(US_ATLAS_TOPO)
]).then(([countyRaw, stateRaw, usTopo]) => {
  US_STATES = topojson.feature(usTopo, usTopo.objects.states).features;
  US_COUNTIES = topojson.feature(usTopo, usTopo.objects.counties).features;

  const cleaned = cleanData(countyRaw, stateRaw, US_COUNTIES);
  ZIP_DATA = cleaned.zipData;
  STATE_DATA = cleaned.stateData;
  COUNTY_DATA = cleaned.countyData;

  populateDropdowns();
  updateGuidedDefaults();
  document.getElementById("loading").classList.add("hidden");
  document.getElementById("charts").style.display = "block";

  const slider = document.getElementById("salarySlider");
  const stateSelect = document.getElementById("stateSelect");

  setSalary(storySalary, true, false);
  setupGuidedActionButtons();
  document.querySelectorAll(".guided-chapter:not(.visual-shown)").forEach(section => section.classList.remove("visual-ready"));
  setupStoryReveals();
  setupScrollStory();
  drawJobComparison();
  setupOfferGuess();

  slider.addEventListener("input", function() { if (isExplorationMode) setSalary(+this.value, true, true); });

  stateSelect.addEventListener("change", function() {
    if (!isExplorationMode) return;
    selectedMapState = this.value;
    updateAll(+slider.value);
  });

  document.getElementById("resetMapButton").addEventListener("click", function() {
    if (!isExplorationMode) return;
    stateSelect.value = "ALL";
    selectedMapState = "ALL";
    updateAll(+slider.value);
  });

  document.getElementById("playSalaryButton").addEventListener("click", () => { if (isExplorationMode) animateSalary(); });

  document.querySelectorAll(".salary-jump").forEach(button => {
    button.addEventListener("click", () => { if (isExplorationMode) setSalary(+button.dataset.salary, true, true); });
  });

  ["compareA", "compareB"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      const a = document.getElementById("compareA");
      const b = document.getElementById("compareB");
      if (!a || !b) return;
      selectedCountyIds = [a.value, b.value];
      drawComparison(+slider.value);
    });
  });

  function handleDreamChange(fips) {
    syncDreamControls(fips);
    drawComparison(isExplorationMode ? +slider.value : storySalary);
    updateGuidedDefaults();
    drawDreamLocation(isExplorationMode ? +slider.value : storySalary);
    updatePersonalSummary(isExplorationMode ? +slider.value : storySalary);
  }

  document.getElementById("dreamSelect").addEventListener("change", () => {
    handleDreamChange(document.getElementById("dreamSelect").value);
  });

  const introDreamSelect = document.getElementById("introDreamSelect");
  if (introDreamSelect) {
    introDreamSelect.addEventListener("change", () => {
      handleDreamChange(introDreamSelect.value);
      storyAutoAnimated = false;
      setSalary(storySalary, true, false);
    });
  }

  ["prefWarm", "prefCoastal", "prefUrban", "prefMidwest", "prefLowRent", "prefBuffer"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => updateRecommendations(+slider.value));
  });

  const prefStateEl = document.getElementById("prefState");
  if (prefStateEl) prefStateEl.addEventListener("change", () => updateRecommendations(+slider.value));

  ["jobCountyA", "jobCountyB"].forEach(id => {
    document.getElementById(id).addEventListener("change", drawJobComparison);
  });
  ["jobSalaryA", "jobSalaryB"].forEach(id => {
    document.getElementById(id).addEventListener("change", drawJobComparison);
  });

  document.querySelectorAll(".salary-choice").forEach(button => {
    button.addEventListener("click", () => {
      storySalary = +button.dataset.salary;
      storyLadderBaseSalary = storySalary;
      storyAutoAnimated = false;
      storyLadderStepIndex = 0;
      document.querySelectorAll(".salary-choice").forEach(btn => btn.classList.remove("active"));
      button.classList.add("active");
      updateGuidedDefaults();
      setSalary(storySalary, true, false);
    });
  });

  const enterButton = document.getElementById("enterExploreMode");
  if (enterButton) enterButton.addEventListener("click", enterExplorationMode);

  window.addEventListener("resize", () => updateAll(+slider.value));
}).catch(err => {
  console.error(err);
  document.getElementById("loading").textContent =
    "Data load failed. Run this with Live Server and make sure ./datasets/rent_income_county_clean.csv and ./datasets/rent_income_state_clean.csv exist.";
});