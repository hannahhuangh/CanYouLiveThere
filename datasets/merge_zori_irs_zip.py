import re
from pathlib import Path

import numpy as np
import pandas as pd

# -----------------------------
# File names
# -----------------------------
# Rent comes directly from Zillow COUNTY-level ZORI.
# ZIP data is only used as an optional helper to estimate county income from IRS ZIP income.
# If the ZIP helper is unavailable or a county does not match, the county row is kept.
COUNTY_ZORI_FILE = "County_zori_uc_sfrcondomfr_sm_sa_month.csv"
IRS_FILE = "22zpallagi.csv"
ZIP_ZORI_FILE = "Zip_zori_uc_sfrcondomfr_sm_sa_month.csv"

COUNTY_OUTPUT = "rent_income_county_clean.csv"
STATE_OUTPUT = "rent_income_state_clean.csv"


def classify_burden(burden):
    if pd.isna(burden):
        return "Missing"
    if burden <= 0.30:
        return "Affordable"
    if burden <= 0.40:
        return "Borderline"
    if burden <= 0.50:
        return "Burdened"
    return "Severely Burdened"


def clean_zip(value):
    if pd.isna(value):
        return None
    return str(value).split(".")[0].zfill(5)


def make_fips(state_fips, county_fips):
    if pd.isna(state_fips) or pd.isna(county_fips):
        return None
    return f"{int(state_fips):02d}{int(county_fips):03d}"


def normalize_county_name(value):
    """Make county labels more comparable across Zillow county and ZIP files."""
    if pd.isna(value):
        return None

    s = str(value).lower().strip()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\bsaint\b", "st", s)

    # Remove common geographic suffixes. This helps match forms like
    # "Los Angeles County" with "Los Angeles", and "St Landry Parish" with "St Landry".
    suffixes = [
        "county",
        "parish",
        "borough",
        "municipality",
        "census area",
        "city and borough",
        "city",
    ]
    for suffix in suffixes:
        s = re.sub(rf"\b{suffix}\b", " ", s)

    s = re.sub(r"\s+", " ", s).strip()
    return s or None


def choose_latest_date_column(df):
    date_cols = [col for col in df.columns if len(str(col)) >= 4 and str(col)[:4].isdigit()]
    if not date_cols:
        raise ValueError("No date columns found in Zillow county ZORI file.")
    return sorted(date_cols)[-1]


print("Loading Zillow county-level ZORI rent data...")
zori = pd.read_csv(COUNTY_ZORI_FILE)
latest_rent_col = choose_latest_date_column(zori)
print(f"Using latest Zillow county rent column: {latest_rent_col}")

county_cols_available = [
    col for col in [
        "RegionID",
        "SizeRank",
        "RegionName",
        "RegionType",
        "State",
        "StateName",
        "Metro",
        "StateCodeFIPS",
        "MunicipalCodeFIPS",
        latest_rent_col,
    ]
    if col in zori.columns
]

county = zori[county_cols_available].copy()
county = county.rename(columns={
    "RegionName": "county",
    "State": "state",
    "StateName": "state_name",
    latest_rent_col: "avg_monthly_rent",
})

county["avg_monthly_rent"] = pd.to_numeric(county["avg_monthly_rent"], errors="coerce")
county["fips"] = county.apply(
    lambda r: make_fips(r.get("StateCodeFIPS"), r.get("MunicipalCodeFIPS")), axis=1
)
county["county_clean"] = county["county"].apply(normalize_county_name)
county = county.dropna(subset=["fips", "avg_monthly_rent"])
county = county[county["avg_monthly_rent"] > 0].copy()

# Start with empty income fields so every county-rent row is preserved.
county["num_returns"] = np.nan
county["avg_annual_income"] = np.nan
county["avg_monthly_income"] = np.nan
county["income_source"] = "missing_income"

# -----------------------------
# Optional income merge
# -----------------------------
# The IRS file is ZIP-level. Zillow's county rent data is already county-level,
# so ZIP rows are NEVER used for rent. ZIP rows are only used to estimate income
# by grouping IRS ZIP income to county labels.
if Path(IRS_FILE).exists() and Path(ZIP_ZORI_FILE).exists():
    print("Creating county income proxy from IRS ZIP data using ZIP county labels...")

    zip_zori = pd.read_csv(ZIP_ZORI_FILE)
    keep_cols = [c for c in ["RegionName", "State", "StateName", "CountyName"] if c in zip_zori.columns]
    zip_zori = zip_zori[keep_cols].copy()
    zip_zori = zip_zori.rename(columns={
        "RegionName": "zip",
        "State": "state",
        "StateName": "state_name",
        "CountyName": "county",
    })
    zip_zori["zip"] = zip_zori["zip"].apply(clean_zip)
    zip_zori["county_clean"] = zip_zori["county"].apply(normalize_county_name)
    zip_zori = zip_zori.dropna(subset=["zip", "state", "county_clean"])
    zip_zori = zip_zori.drop_duplicates(subset=["zip", "state", "county_clean"])

    irs = pd.read_csv(IRS_FILE, usecols=["zipcode", "N1", "A00100"])
    irs = irs.rename(columns={
        "zipcode": "zip",
        "N1": "num_returns",
        "A00100": "total_agi_thousands",
    })
    irs["zip"] = irs["zip"].apply(clean_zip)
    irs["num_returns"] = pd.to_numeric(irs["num_returns"], errors="coerce")
    irs["total_agi_thousands"] = pd.to_numeric(irs["total_agi_thousands"], errors="coerce")
    irs = irs.dropna(subset=["zip", "num_returns", "total_agi_thousands"])
    irs = irs[irs["num_returns"] > 0].copy()
    irs["total_agi"] = irs["total_agi_thousands"] * 1000

    zip_income = zip_zori.merge(irs[["zip", "num_returns", "total_agi"]], on="zip", how="inner")

    county_income = zip_income.groupby(["state", "county_clean"], as_index=False).agg(
        num_returns=("num_returns", "sum"),
        total_agi=("total_agi", "sum"),
    )
    county_income["avg_annual_income"] = county_income["total_agi"] / county_income["num_returns"]
    county_income["avg_monthly_income"] = county_income["avg_annual_income"] / 12
    county_income["income_source"] = "county_income_from_irs_zip"

    county = county.merge(
        county_income[[
            "state", "county_clean", "num_returns", "avg_annual_income",
            "avg_monthly_income", "income_source"
        ]],
        on=["state", "county_clean"],
        how="left",
        suffixes=("", "_matched"),
    )

    for col in ["num_returns", "avg_annual_income", "avg_monthly_income", "income_source"]:
        matched_col = f"{col}_matched"
        county[col] = county[matched_col].combine_first(county[col])
        county = county.drop(columns=[matched_col])

    # State fallback: this keeps county rent rows usable in the UI even when the
    # county income proxy cannot be matched. The income_source column makes this clear.
    state_income = zip_income.groupby("state", as_index=False).agg(
        state_num_returns=("num_returns", "sum"),
        state_total_agi=("total_agi", "sum"),
    )
    state_income["state_avg_annual_income"] = state_income["state_total_agi"] / state_income["state_num_returns"]
    state_income["state_avg_monthly_income"] = state_income["state_avg_annual_income"] / 12

    county = county.merge(
        state_income[["state", "state_avg_annual_income", "state_avg_monthly_income"]],
        on="state",
        how="left",
    )

    missing_income = county["avg_monthly_income"].isna()
    county.loc[missing_income, "avg_annual_income"] = county.loc[missing_income, "state_avg_annual_income"]
    county.loc[missing_income, "avg_monthly_income"] = county.loc[missing_income, "state_avg_monthly_income"]
    county.loc[missing_income & county["avg_monthly_income"].notna(), "income_source"] = "state_income_fallback"

    county = county.drop(columns=["state_avg_annual_income", "state_avg_monthly_income"])

else:
    print("IRS ZIP file or ZIP helper file was not found. County rent rows will still be saved.")
    print("If an older state output exists, it will only be used as a fallback income estimate.")
    if Path(STATE_OUTPUT).exists():
        state_income = pd.read_csv(STATE_OUTPUT)
        state_income = state_income[["state", "avg_annual_income", "avg_monthly_income"]].drop_duplicates("state")
        county = county.merge(state_income, on="state", how="left", suffixes=("", "_state"))
        missing_income = county["avg_monthly_income"].isna()
        county.loc[missing_income, "avg_annual_income"] = county.loc[missing_income, "avg_annual_income_state"]
        county.loc[missing_income, "avg_monthly_income"] = county.loc[missing_income, "avg_monthly_income_state"]
        county.loc[missing_income & county["avg_monthly_income"].notna(), "income_source"] = "previous_state_output_fallback"
        county = county.drop(columns=["avg_annual_income_state", "avg_monthly_income_state"])

county["avg_rent_burden"] = county["avg_monthly_rent"] / county["avg_monthly_income"]
county["rent_burden_percent"] = county["avg_rent_burden"] * 100
county["required_income"] = county["avg_monthly_rent"] * 12 / 0.30
county["affordability_category"] = county["avg_rent_burden"].apply(classify_burden)
county["latest_rent_month"] = latest_rent_col
county["county_count"] = 1
county = county.replace([np.inf, -np.inf], np.nan)

county_cols = [
    "fips", "county", "county_clean", "state", "state_name", "Metro",
    "RegionID", "SizeRank", "RegionType", "StateCodeFIPS", "MunicipalCodeFIPS",
    "avg_monthly_rent", "num_returns", "avg_annual_income", "avg_monthly_income",
    "avg_rent_burden", "rent_burden_percent", "affordability_category",
    "required_income", "latest_rent_month", "income_source", "county_count",
]
county_cols = [col for col in county_cols if col in county.columns]
county[county_cols].to_csv(COUNTY_OUTPUT, index=False)
print(f"Saved county-level data to {COUNTY_OUTPUT}")
print(f"Rows saved: {len(county)}")
print("Income source counts:")
print(county["income_source"].value_counts(dropna=False))

print("Creating state-level summary from county-level rent data...")
state = county.groupby("state", as_index=False).agg(
    state_name=("state_name", "first"),
    avg_monthly_rent=("avg_monthly_rent", "mean"),
    avg_annual_income=("avg_annual_income", "mean"),
    avg_monthly_income=("avg_monthly_income", "mean"),
    avg_rent_burden=("avg_rent_burden", "mean"),
    county_count=("fips", "count"),
)
state["rent_burden_percent"] = state["avg_rent_burden"] * 100
state["affordability_category"] = state["avg_rent_burden"].apply(classify_burden)

# Keep the old column name too, because the website may still refer to it.
state["zip_count"] = state["county_count"]
state.to_csv(STATE_OUTPUT, index=False)
print(f"Saved state-level data to {STATE_OUTPUT}")
print(f"Rows saved: {len(state)}")

print("\nPreview of county-level data:")
print(county[county_cols].head())
print("\nDone!")
