const ZIP_FILE = "./datasets/rent_income_zip_clean.csv";
const STATE_FILE = "./datasets/rent_income_state_clean.csv";
const US_ATLAS_TOPO = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";

const tooltip = d3.select("#tooltip");

let ZIP_DATA = [];
let STATE_DATA = [];
let COUNTY_DATA = [];
let US_STATES = null;
let US_COUNTIES = null;
let selectedMapState = "ALL";
let selectedCountyIds = [];
let isAnimatingSalary = false;

// Tracks whether the user has explicitly chosen a salary (slider, jump buttons, animate).
// When true, scroll-triggered salary changes are ignored so the user's choice persists.
let userHasSetSalary = false;

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
  const parent = document.getElementById(id).parentElement;
  const W = Math.max(320, parent.clientWidth - 48);
  const H = customHeight;
  const svg = d3.select("#" + id).attr("height", H).html("");
  return { svg, W, H };
}

function cleanData(zipData, stateData, countyFeatures) {
  const countyNameToFips = new Map();

  countyFeatures.forEach(feature => {
    const fips = String(feature.id).padStart(5, "0");
    const state = fipsToState[fips.slice(0, 2)];
    const countyName = feature.properties && feature.properties.name;
    if (!state || !countyName) return;
    countyNameToFips.set(`${state}|${normalizeCountyName(countyName)}`, fips);
  });

  zipData.forEach(d => {
    d.zip = String(d.zip).padStart(5, "0");
    d.city = d.city || "Unknown";
    d.state = d.state || "Unknown";
    d.county = d.county || "Unknown County";
    d.monthly_rent = +d.monthly_rent;
    d.num_returns = +d.num_returns || 0;
    d.avg_annual_income = +d.avg_annual_income;
    d.avg_monthly_income = +d.avg_monthly_income;
    d.local_rent_burden = +d.rent_burden;
    d.local_rent_burden_percent = +d.rent_burden_percent;
    d.required_income = d.monthly_rent * 12 / 0.30;
  });

  zipData = zipData.filter(d =>
    isFinite(d.monthly_rent) &&
    isFinite(d.avg_annual_income) &&
    isFinite(d.required_income) &&
    d.monthly_rent > 0 &&
    d.avg_annual_income > 0
  );

  stateData.forEach(d => {
    d.avg_monthly_rent = +d.avg_monthly_rent;
    d.avg_annual_income = +d.avg_annual_income;
    d.avg_monthly_income = +d.avg_monthly_income;
    d.local_rent_burden = +d.avg_rent_burden;
    d.local_rent_burden_percent = +d.rent_burden_percent;
    d.zip_count = +d.zip_count;
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

  const countyRollup = d3.rollups(
    zipData,
    rows => {
      const totalReturns = d3.sum(rows, r => r.num_returns || 0);
      const weightedRent = totalReturns > 0
        ? d3.sum(rows, r => r.monthly_rent * (r.num_returns || 0)) / totalReturns
        : d3.mean(rows, r => r.monthly_rent);
      const weightedIncome = totalReturns > 0
        ? d3.sum(rows, r => r.avg_annual_income * (r.num_returns || 0)) / totalReturns
        : d3.mean(rows, r => r.avg_annual_income);
      const fips = countyNameToFips.get(`${rows[0].state}|${normalizeCountyName(rows[0].county)}`);

      return {
        id: fips,
        state: rows[0].state,
        county: rows[0].county,
        fips,
        label: `${rows[0].county}, ${rows[0].state}`,
        avg_monthly_rent: weightedRent,
        avg_annual_income: weightedIncome,
        zip_count: rows.length,
        required_income: weightedRent * 12 / 0.30
      };
    },
    d => `${d.state}|${normalizeCountyName(d.county)}`
  ).map(d => d[1]).filter(d => d.fips && isFinite(d.avg_monthly_rent));

  return { zipData, stateData, countyData: countyRollup };
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
      salary_category: categoryFromBurden(burden)
    };
  });
}

// setSalary: the single source of truth for changing the salary.
// fromUser=true means the user explicitly set it (slider, jump button, animate).
// fromUser=false means a scroll trigger is trying to change it.
function setSalary(value, shouldUpdate = true, fromUser = false) {
  const salary = Math.max(30000, Math.min(250000, Math.round(value / 5000) * 5000));

  // If scroll is trying to set salary but the user has already set one, ignore it.
  if (!fromUser && userHasSetSalary) return;

  if (fromUser) userHasSetSalary = true;

  document.getElementById("salarySlider").value = salary;
  d3.select("#salaryValue").text(formatDollar(salary));
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
            Click to zoom into counties<br>
            Selected income: ${formatDollar(salary)}<br>
            Avg monthly rent: ${formatDollar(row.avg_monthly_rent)}<br>
            Rent burden: ${formatPercent(row.salary_rent_burden_percent)}<br>
            Category: ${row.salary_category}<br>
            ZIPs included: ${row.zip_count}
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
      const fips = String(d.id).padStart(5, "0");
      const row = countyByFips.get(fips);
      if (!row) return;

      // Update comparison selection — keep up to 2, most recent first
      selectedCountyIds = [fips, ...selectedCountyIds.filter(id => id !== fips)].slice(0, 2);
      syncComparisonDropdowns();

      // Also update the dream dropdown to this county so Ch4 reacts immediately
      d3.select("#dreamSelect").property("value", fips);

      // Redraw comparison and dream without resetting salary
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
          Click to add to comparison & set dream county<br>
          Selected income: ${formatDollar(salary)}<br>
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

// Income ladder: static chart showing % affordable at fixed incomes,
// with a live marker showing where the current salary lands.
function drawIncomeLadder(currentSalary) {
  const { svg, W, H } = chartFrame("ladderChart", 310);
  const margin = { top: 20, right: 20, bottom: 45, left: 42 };
  const incomes = [40000, 60000, 80000, 100000, 150000, 200000];
  const data = incomes.map(income => {
    const rows = withSalary(COUNTY_DATA, income);
    return {
      income,
      share: rows.filter(d => d.salary_rent_burden <= 0.30).length / rows.length
    };
  });

  const x = d3.scaleBand().domain(data.map(d => d.income)).range([margin.left, W - margin.right]).padding(0.28);
  const y = d3.scaleLinear().domain([0, 1]).nice().range([H - margin.bottom, margin.top]);

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${H - margin.bottom})`)
    .call(d3.axisBottom(x).tickFormat(formatDollar));

  svg.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(".0%")));

  svg.selectAll("rect")
    .data(data)
    .enter()
    .append("rect")
    .attr("x", d => x(d.income))
    .attr("y", d => y(d.share))
    .attr("width", x.bandwidth())
    .attr("height", d => y(0) - y(d.share))
    .attr("fill", "#65c7ff")
    .attr("opacity", 0.75);

  svg.selectAll("text.value")
    .data(data)
    .enter()
    .append("text")
    .attr("class", "axis-label")
    .attr("x", d => x(d.income) + x.bandwidth() / 2)
    .attr("y", d => y(d.share) - 7)
    .attr("text-anchor", "middle")
    .text(d => d3.format(".0%")(d.share));

  // Live salary marker: interpolate where the current salary falls
  if (currentSalary && isFinite(currentSalary)) {
    // Interpolate the affordable share at the exact current salary
    const currentShare = withSalary(COUNTY_DATA, currentSalary)
      .filter(d => d.salary_rent_burden <= 0.30).length / COUNTY_DATA.length;

    // Place marker at the x midpoint of the nearest band
    const nearest = incomes.reduce((a, b) => Math.abs(b - currentSalary) < Math.abs(a - currentSalary) ? b : a);
    const markerX = x(nearest) + x.bandwidth() / 2;
    const markerY = y(currentShare);

    // Draw a vertical dashed line
    svg.append("line")
      .attr("x1", markerX).attr("x2", markerX)
      .attr("y1", margin.top).attr("y2", H - margin.bottom)
      .attr("stroke", "#ffb84d")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "4,3")
      .attr("opacity", 0.75);

    // Draw a dot at the intersection
    svg.append("circle")
      .attr("cx", markerX)
      .attr("cy", markerY)
      .attr("r", 5)
      .attr("fill", "#ffb84d")
      .attr("stroke", "#050711")
      .attr("stroke-width", 1.5);

    // Label
    svg.append("text")
      .attr("class", "axis-label")
      .attr("x", markerX + 7)
      .attr("y", markerY - 7)
      .attr("fill", "#ffb84d")
      .text(`← ${formatDollar(currentSalary)}: ${d3.format(".0%")(currentShare)} affordable`);
  }

  // Update the insight text in Ch2
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

function populateDropdowns() {
  const states = Array.from(new Set(STATE_DATA.map(d => d.state))).sort();
  const stateSelect = d3.select("#stateSelect");
  stateSelect.html("");
  stateSelect.append("option").attr("value", "ALL").text("All states");
  stateSelect.selectAll("option.state-option")
    .data(states)
    .enter()
    .append("option")
    .attr("class", "state-option")
    .attr("value", d => d)
    .text(d => d);

  const countyOptions = COUNTY_DATA.slice().sort((a, b) => d3.ascending(countyLabel(a), countyLabel(b)));
  ["#compareA", "#compareB", "#dreamSelect"].forEach(id => {
    const select = d3.select(id).html("");
    select.selectAll("option")
      .data(countyOptions)
      .enter()
      .append("option")
      .attr("value", d => d.fips)
      .text(d => countyLabel(d));
  });

  const caSanDiego = COUNTY_DATA.find(d => d.state === "CA" && normalizeCountyName(d.county).includes("san diego"));
  const midwest = COUNTY_DATA.find(d => ["OH", "MI", "IN", "PA"].includes(d.state));
  selectedCountyIds = [caSanDiego?.fips, midwest?.fips].filter(Boolean);
  if (selectedCountyIds.length < 2) selectedCountyIds = countyOptions.slice(0, 2).map(d => d.fips);
  syncComparisonDropdowns();
  d3.select("#dreamSelect").property("value", selectedCountyIds[0]);
}

function syncComparisonDropdowns() {
  if (selectedCountyIds[0]) d3.select("#compareA").property("value", selectedCountyIds[0]);
  if (selectedCountyIds[1]) d3.select("#compareB").property("value", selectedCountyIds[1]);
}

function drawComparison(salary) {
  selectedCountyIds = [document.getElementById("compareA").value, document.getElementById("compareB").value];
  const rows = selectedCountyIds.map(id => COUNTY_DATA.find(d => d.fips === id)).filter(Boolean);
  const salaryRows = withSalary(rows, salary);

  const cards = d3.select("#comparisonCards").html("");
  cards.selectAll("div")
    .data(salaryRows)
    .enter()
    .append("div")
    .attr("class", "place-card")
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

  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - margin.bottom})`).call(d3.axisBottom(x)).selectAll("text").attr("transform", "rotate(-12)").style("text-anchor", "end");
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d => d + "%"));

  svg.append("line")
    .attr("x1", margin.left).attr("x2", W - margin.right)
    .attr("y1", y(30)).attr("y2", y(30))
    .attr("stroke", "#ffb84d").attr("stroke-dasharray", "5,4");

  svg.append("text")
    .attr("class", "axis-label")
    .attr("x", W - margin.right).attr("y", y(30) - 6)
    .attr("text-anchor", "end").text("30% affordable line");

  svg.selectAll("rect")
    .data(salaryRows)
    .enter()
    .append("rect")
    .attr("x", d => x(countyLabel(d)))
    .attr("y", d => y(d.salary_rent_burden_percent))
    .attr("width", x.bandwidth())
    .attr("height", d => y(0) - y(d.salary_rent_burden_percent))
    .attr("fill", d => burdenColor(d.salary_rent_burden))
    .attr("opacity", 0.9);
}

function drawDreamLocation(salary) {
  const id = document.getElementById("dreamSelect").value;
  const row = COUNTY_DATA.find(d => d.fips === id);
  if (!row) return;

  const burden = row.avg_monthly_rent / (salary / 12);
  d3.select("#dreamTitle").text(countyLabel(row));
  d3.select("#dreamRequiredIncome").text(formatDollar(row.required_income));
  d3.select("#dreamDetails").text(`At ${formatDollar(salary)}, average rent would take ${formatPercent(burden * 100)} of income. The 30% rule says this county needs about ${formatDollar(row.required_income)} per year.`);

  const { svg, W, H } = chartFrame("dreamChart", 210);
  const margin = { top: 25, right: 20, bottom: 35, left: 36 };
  const data = [
    { label: "Your salary", value: salary },
    { label: "Needed", value: row.required_income }
  ];
  const x = d3.scaleBand().domain(data.map(d => d.label)).range([margin.left, W - margin.right]).padding(0.35);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.value) * 1.2]).nice().range([H - margin.bottom, margin.top]);

  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - margin.bottom})`).call(d3.axisBottom(x));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(formatDollar));
  svg.selectAll("rect")
    .data(data)
    .enter()
    .append("rect")
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

  const medianZips = d3.median(COUNTY_DATA, r => r.zip_count);

  let rows = withSalary(COUNTY_DATA, salary)
    .filter(d => d.salary_rent_burden <= 0.30)
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

  list.selectAll("div")
    .data(rows)
    .enter()
    .append("div")
    .attr("class", "recommendation-item")
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
  const W = Math.max(280, parent.clientWidth - 8);
  const H = 320;
  const svg = d3.select("#recMapChart").attr("height", H).attr("width", W).html("");

  const matchedFips = new Set(matchedRows.map(d => d.fips));

  const projection = d3.geoAlbersUsa();
  projection.fitSize([W, H], { type: "FeatureCollection", features: US_STATES });
  const path = d3.geoPath(projection);

  // Draw all states as base layer
  svg.append("g").selectAll("path")
    .data(US_STATES)
    .enter().append("path")
    .attr("d", path)
    .attr("fill", "#d8e6ee")
    .attr("stroke", "white")
    .attr("stroke-width", 0.5);

  // Draw matched counties highlighted
  svg.append("g").selectAll("path")
    .data(US_COUNTIES.filter(d => matchedFips.has(String(d.id).padStart(5, "0"))))
    .enter().append("path")
    .attr("d", path)
    .attr("fill", "#FC8A10")
    .attr("stroke", "white")
    .attr("stroke-width", 0.8)
    .attr("opacity", 0.9)
    .on("mousemove", (event, d) => {
      const fips = String(d.id).padStart(5, "0");
      const row = matchedRows.find(r => r.fips === fips);
      if (!row) return;
      tooltip
        .style("opacity", 1)
        .style("left", event.clientX + 14 + "px")
        .style("top", event.clientY + 14 + "px")
        .html(`<strong>${countyLabel(row)}</strong>Rent: ${formatDollar(row.avg_monthly_rent)}/mo<br>Burden: ${formatPercent(row.salary_rent_burden_percent)}`);
    })
    .on("mouseleave", () => tooltip.style("opacity", 0));

  // Rank labels on matched counties
  matchedRows.forEach((row, i) => {
    const feature = US_COUNTIES.find(d => String(d.id).padStart(5, "0") === row.fips);
    if (!feature) return;
    const centroid = path.centroid(feature);
    if (!centroid || !isFinite(centroid[0])) return;
    svg.append("circle")
      .attr("cx", centroid[0]).attr("cy", centroid[1])
      .attr("r", 8)
      .attr("fill", "#FC8A10")
      .attr("stroke", "white")
      .attr("stroke-width", 1.5);
    svg.append("text")
      .attr("x", centroid[0]).attr("y", centroid[1] + 4)
      .attr("text-anchor", "middle")
      .attr("fill", "white")
      .attr("font-size", 9)
      .attr("font-weight", "700")
      .text(i + 1);
  });
}

// Central update: everything reads from the single salary value.
function updateAll(salary) {
  selectedMapState = document.getElementById("stateSelect").value;
  const salaryStateData = withSalary(STATE_DATA, salary);
  const salaryCountyData = withSalary(COUNTY_DATA, salary);

  d3.select("#salaryValue").text(formatDollar(salary));
  updateStats(salaryStateData, salaryCountyData, salary);
  drawSalaryMap(salaryStateData, salaryCountyData, salary);
  drawIncomeLadder(salary);   // re-draw with current salary marker
  drawComparison(salary);
  drawDreamLocation(salary);
  updateRecommendations(salary);
}

function setupScrollStory() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const salary = +entry.target.dataset.salary;
      // fromUser=false — scroll never overrides an explicit user choice
      if (salary && !isAnimatingSalary) setSalary(salary, true, false);
    });
  }, { threshold: 0.55 });

  document.querySelectorAll(".chapter[data-salary]").forEach(section => observer.observe(section));
}

async function animateSalary() {
  if (isAnimatingSalary) return;
  isAnimatingSalary = true;
  userHasSetSalary = true;   // animation counts as an explicit user action
  const button = document.getElementById("playSalaryButton");
  button.textContent = "Animating...";
  const steps = [40000, 60000, 80000, 100000, 125000, 150000];
  for (const salary of steps) {
    setSalary(salary, true, true);
    await new Promise(resolve => setTimeout(resolve, 650));
  }
  button.textContent = "Animate raise";
  isAnimatingSalary = false;
}

Promise.all([
  d3.csv(ZIP_FILE),
  d3.csv(STATE_FILE),
  d3.json(US_ATLAS_TOPO)
]).then(([zipRaw, stateRaw, usTopo]) => {
  US_STATES = topojson.feature(usTopo, usTopo.objects.states).features;
  US_COUNTIES = topojson.feature(usTopo, usTopo.objects.counties).features;

  const cleaned = cleanData(zipRaw, stateRaw, US_COUNTIES);
  ZIP_DATA = cleaned.zipData;
  STATE_DATA = cleaned.stateData;
  COUNTY_DATA = cleaned.countyData;

  populateDropdowns();
  document.getElementById("loading").classList.add("hidden");
  document.getElementById("charts").style.display = "block";

  const slider = document.getElementById("salarySlider");
  const stateSelect = document.getElementById("stateSelect");

  updateAll(+slider.value);
  setupScrollStory();

  // Slider: explicit user action
  slider.addEventListener("input", function() {
    setSalary(+this.value, true, true);
  });

  stateSelect.addEventListener("change", function() {
    selectedMapState = this.value;
    updateAll(+slider.value);
  });

  document.getElementById("resetMapButton").addEventListener("click", function() {
    stateSelect.value = "ALL";
    selectedMapState = "ALL";
    updateAll(+slider.value);
  });

  document.getElementById("playSalaryButton").addEventListener("click", animateSalary);

  // Salary jump buttons: explicit user action — sets lock
  document.querySelectorAll(".salary-jump").forEach(button => {
    button.addEventListener("click", () => setSalary(+button.dataset.salary, true, true));
  });

  // Comparison or dream dropdown changes: propagate to all sections
  ["compareA", "compareB"].forEach(id => {
    document.getElementById(id).addEventListener("change", () => {
      selectedCountyIds = [
        document.getElementById("compareA").value,
        document.getElementById("compareB").value
      ];
      drawComparison(+slider.value);
    });
  });

  // Dream select change: also update comparison slot A so map and Ch3 stay in sync
  document.getElementById("dreamSelect").addEventListener("change", () => {
    const fips = document.getElementById("dreamSelect").value;
    selectedCountyIds = [fips, selectedCountyIds[1] || fips];
    syncComparisonDropdowns();
    drawComparison(+slider.value);
    drawDreamLocation(+slider.value);
  });

  ["prefWarm", "prefCoastal", "prefUrban", "prefMidwest", "prefLowRent", "prefBuffer"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => updateRecommendations(+slider.value));
  });

  window.addEventListener("resize", () => updateAll(+slider.value));
}).catch(err => {
  console.error(err);
  document.getElementById("loading").textContent =
    "Data load failed. Run this with Live Server and make sure ./datasets/rent_income_zip_clean.csv and ./datasets/rent_income_state_clean.csv exist.";
});