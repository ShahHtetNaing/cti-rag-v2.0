"""End-to-end evaluation of the deployed CTI RAG API (Colab backend via Cloudflare tunnel).

Measures what a website user experiences: network + retrieval + generation latency,
citation use and abstention for every question in questions.csv. Manual 0-2 scores
for correctness, grounding and relevance are left blank for human review.

Usage:
    python evaluation/run_api_evaluation.py --backend https://xxxx.trycloudflare.com --key ACCESS_KEY
"""
import argparse
import csv
import json
import re
import statistics
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CITATION = re.compile(r"\[(?:S|C|V|R|L)\d+\]")
NOT_FOUND = "not found in the selected datasets or live api results"


def post_query(backend, key, question, mode):
    payload = json.dumps({"question": question, "mode": mode, "use_live_api": False}).encode()
    request = urllib.request.Request(
        f"{backend.rstrip('/')}/api/query",
        data=payload,
        headers={"Content-Type": "application/json", "X-Access-Key": key},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def answer_body(answer):
    return re.split(r"\n\n### Dataset citations|\n\n---\n\*Processing", answer or "", maxsplit=1)[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True, help="Backend URL printed by the Colab serving cell")
    parser.add_argument("--key", required=True, help="Access key printed by the Colab serving cell")
    parser.add_argument("--questions", default=str(HERE / "questions.csv"))
    parser.add_argument("--out", default=str(HERE / "results" / "api_evaluation_results.csv"))
    args = parser.parse_args()

    with open(args.questions, newline="", encoding="utf-8") as f:
        questions = list(csv.DictReader(f))

    rows = []
    for item in questions:
        start = time.perf_counter()
        result = post_query(args.backend, args.key, item["question"], item["mode"])
        round_trip = time.perf_counter() - start
        body = answer_body(result["answer_markdown"])
        timings = result.get("timings", {})
        rows.append({
            "category": item["category"],
            "mode": item["mode"],
            "question": item["question"],
            "round_trip_seconds": round(round_trip, 3),
            "retrieval_seconds": timings.get("retrieval_seconds"),
            "generation_seconds": timings.get("generation_seconds"),
            "server_seconds": timings.get("server_seconds"),
            "network_overhead_seconds": round(round_trip - (timings.get("server_seconds") or 0), 3),
            "citations": len(CITATION.findall(body)),
            "abstained": NOT_FOUND in body.lower(),
            "answer_markdown": result["answer_markdown"],
            "correctness_0_to_2": "",
            "grounding_0_to_2": "",
            "relevance_0_to_2": "",
            "review_notes": "",
        })
        print(f"[{item['category']}] {round_trip:.2f}s round trip, {rows[-1]['citations']} citations")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    latencies = [r["round_trip_seconds"] for r in rows]
    print(f"\nMean round trip {statistics.mean(latencies):.2f}s, median {statistics.median(latencies):.2f}s, max {max(latencies):.2f}s")
    print(f"Saved {out}. Fill in the manual 0-2 scores after checking each claim against its sources.")


if __name__ == "__main__":
    main()
