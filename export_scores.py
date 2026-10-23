"""Score the test claims and export the files the dashboard reads.

Usage:
    python export_scores.py [test_claims_csv]
Writes:
    data/fraud_scored_providers.csv
    data/metrics.json
"""
import json
import sys
from datetime import datetime

import features as F
from scoring import load_model, score_claims

TEST_CSV = sys.argv[1] if len(sys.argv) > 1 else "data/test_imputed.csv"

model = load_model()
claims = F.read_claims(TEST_CSV)
scored = score_claims(claims, model)
scored.to_csv("data/fraud_scored_providers.csv", index=False)

flagged = int((scored["predicted_fraud"] == "Yes").sum())
with open("data/metrics.json", "w", encoding="utf-8") as f:
    json.dump({
        "threshold": model["thr"],
        "metrics": model["metrics"],
        "importance": model["importance"],
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "n_test_providers": int(len(scored)),
        "n_test_flagged": flagged,
    }, f, indent=2)

print("Providers scored :", len(scored))
print("Flagged as fraud :", flagged, f"({flagged / len(scored):.1%})")
print("Saved data/fraud_scored_providers.csv and data/metrics.json")
