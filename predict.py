"""Score one uploaded claim-level CSV and print the result as JSON (used by the Node upload endpoint).

Usage:
    python predict.py <claims_csv>
Exit codes: 0 = ok, 2 = bad input file (for example missing columns), 1 = other error.
"""
import json
import sys

import features as F
from scoring import load_model, score_claims


def fail(message, code):
    print(json.dumps({"error": message}))
    sys.exit(code)


if len(sys.argv) < 2:
    fail("No input file given.", 2)

try:
    claims = F.read_claims(sys.argv[1])
except Exception as e:
    fail(f"Could not read the CSV file: {e}", 2)

try:
    missing = F.check_columns(claims)
except ValueError as e:
    fail(str(e), 2)
if missing:
    fail("Missing required columns: " + ", ".join(missing), 2)

try:
    model = load_model()
except Exception as e:
    fail(f"Could not load model/fraud_model.joblib. Run training.py first. ({e})", 1)

try:
    scored = score_claims(claims, model)
except Exception as e:
    fail(f"Scoring failed: {e}", 1)

print(json.dumps({"threshold": model["thr"], "providers": scored.to_dict(orient="records")}))
