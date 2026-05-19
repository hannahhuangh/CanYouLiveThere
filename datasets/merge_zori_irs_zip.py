import pandas as pd
import numpy as np

# -----------------------------
# File names
# -----------------------------
ZORI_FILE = "Zip_zori_uc_sfrcondomfr_sm_sa_month.csv"
IRS_FILE = "22zpallagi.csv"

ZIP_OUTPUT = "rent_income_zip_clean.csv"
CITY_OUTPUT = "rent_income_city_clean.csv"
STATE_OUTPUT = "rent_income_state_clean.csv"


# -----------------------------
# Helper functions
# -----------------------------
def clean_zip(value):
    """
    Makes sure ZIP codes are 5-digit strings.
    Example: 9212 -> 09212
    """
    if pd.isna(value):
        return None
    return str(value).split(".")[0].zfill(5)


def classify_burden(burden):
    """
    Classifies rent burden based on common affordability thresholds.
    """
    if pd.isna(burden):
        return "Missing"
    if burden <= 0.30:
        return "Affordable"
    elif burden <= 0.40:
        return "Borderline"
    elif burden <= 0.50:
        return "Burdened"
    else:
        return "Severely Burdened"


# -----------------------------
# Load Zillow ZORI rent data
# -----------------------------
print("Loading Zillow ZORI rent data...")

zori = pd.read_csv(ZORI_FILE)

# Find all date columns in Zillow file
date_cols = [col for col in zori.columns if col[:4].isdigit()]

if not date_cols:
    raise ValueError("No date columns found in Zillow ZORI file.")

# Use latest available date column
latest_rent_col = sorted(date_cols)[-1]

print(f"Using latest Zillow rent column: {latest_rent_col}")

zori_clean = zori[[
    "RegionName",
    "City",
    "State",
    "Metro",
    "CountyName",
    latest_rent_col
]].copy()

zori_clean = zori_clean.rename(columns={
    "RegionName": "zip",
    "City": "city",
    "State": "state",
    "Metro": "metro",
    "CountyName": "county",
    latest_rent_col: "monthly_rent"
})

zori_clean["zip"] = zori_clean["zip"].apply(clean_zip)
zori_clean["monthly_rent"] = pd.to_numeric(zori_clean["monthly_rent"], errors="coerce")

# Drop rows without rent
zori_clean = zori_clean.dropna(subset=["zip", "monthly_rent"])


# -----------------------------
# Load IRS AGI income data
# -----------------------------
print("Loading IRS income data...")

irs = pd.read_csv(IRS_FILE)

# IRS columns usually include:
# zipcode = ZIP code
# N1 = number of returns
# A00100 = adjusted gross income amount, usually in thousands of dollars

irs_clean = irs[["zipcode", "N1", "A00100"]].copy()

irs_clean = irs_clean.rename(columns={
    "zipcode": "zip",
    "N1": "num_returns",
    "A00100": "total_agi_thousands"
})

irs_clean["zip"] = irs_clean["zip"].apply(clean_zip)
irs_clean["num_returns"] = pd.to_numeric(irs_clean["num_returns"], errors="coerce")
irs_clean["total_agi_thousands"] = pd.to_numeric(irs_clean["total_agi_thousands"], errors="coerce")

# Remove invalid ZIPs and invalid income rows
irs_clean = irs_clean.dropna(subset=["zip", "num_returns", "total_agi_thousands"])
irs_clean = irs_clean[irs_clean["num_returns"] > 0]

# Convert AGI from thousands of dollars to dollars
irs_clean["total_agi"] = irs_clean["total_agi_thousands"] * 1000

# Average annual income proxy
irs_clean["avg_annual_income"] = irs_clean["total_agi"] / irs_clean["num_returns"]

# Average monthly income proxy
irs_clean["avg_monthly_income"] = irs_clean["avg_annual_income"] / 12


# -----------------------------
# Merge Zillow + IRS by ZIP
# -----------------------------
print("Merging rent and income data by ZIP code...")

merged = pd.merge(
    zori_clean,
    irs_clean[["zip", "num_returns", "avg_annual_income", "avg_monthly_income"]],
    on="zip",
    how="inner"
)

# Calculate rent burden
merged["rent_burden"] = merged["monthly_rent"] / merged["avg_monthly_income"]
merged["rent_burden_percent"] = merged["rent_burden"] * 100
merged["affordability_category"] = merged["rent_burden"].apply(classify_burden)

# Remove extreme or invalid values for cleaner visualizations
merged = merged.replace([np.inf, -np.inf], np.nan)
merged = merged.dropna(subset=[
    "monthly_rent",
    "avg_annual_income",
    "avg_monthly_income",
    "rent_burden"
])

# Optional: remove extreme outliers
merged = merged[
    (merged["monthly_rent"] > 0) &
    (merged["avg_annual_income"] > 0) &
    (merged["rent_burden"] < 3)
]

# Save ZIP-level file
merged.to_csv(ZIP_OUTPUT, index=False)

print(f"Saved ZIP-level data to {ZIP_OUTPUT}")
print(f"Rows saved: {len(merged)}")


# -----------------------------
# City-level aggregation
# -----------------------------
print("Creating city-level summary...")

city = merged.groupby(["city", "state"], as_index=False).agg(
    avg_monthly_rent=("monthly_rent", "mean"),
    avg_annual_income=("avg_annual_income", "mean"),
    avg_monthly_income=("avg_monthly_income", "mean"),
    avg_rent_burden=("rent_burden", "mean"),
    zip_count=("zip", "count")
)

city["rent_burden_percent"] = city["avg_rent_burden"] * 100
city["affordability_category"] = city["avg_rent_burden"].apply(classify_burden)

# Keep cities with at least 2 ZIP codes if you want more stable averages
# Comment this out if you want every city
city = city[city["zip_count"] >= 2]

city.to_csv(CITY_OUTPUT, index=False)

print(f"Saved city-level data to {CITY_OUTPUT}")
print(f"Rows saved: {len(city)}")


# -----------------------------
# State-level aggregation
# -----------------------------
print("Creating state-level summary...")

state = merged.groupby("state", as_index=False).agg(
    avg_monthly_rent=("monthly_rent", "mean"),
    avg_annual_income=("avg_annual_income", "mean"),
    avg_monthly_income=("avg_monthly_income", "mean"),
    avg_rent_burden=("rent_burden", "mean"),
    zip_count=("zip", "count")
)

state["rent_burden_percent"] = state["avg_rent_burden"] * 100
state["affordability_category"] = state["avg_rent_burden"].apply(classify_burden)

state.to_csv(STATE_OUTPUT, index=False)

print(f"Saved state-level data to {STATE_OUTPUT}")
print(f"Rows saved: {len(state)}")


# -----------------------------
# Preview
# -----------------------------
print("\nPreview of merged ZIP-level data:")
print(merged.head())

print("\nDone!")