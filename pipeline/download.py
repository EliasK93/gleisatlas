"""Download one monthly source file from the public HuggingFace dataset into data/raw/."""

import re
import sys

from huggingface_hub import hf_hub_download

REPO = "piebro/deutsche-bahn-data"


def download(month: str, local_dir: str = "data/raw") -> str:
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        sys.exit("usage: python -m pipeline.download YYYY-MM")
    return hf_hub_download(
        REPO,
        f"monthly_processed_data/data-{month}.parquet",
        repo_type="dataset",
        local_dir=local_dir,
    )


def main(argv: list[str]) -> None:
    if len(argv) != 1:
        sys.exit("usage: python -m pipeline.download YYYY-MM")
    print(f"downloaded: {download(argv[0])}")


if __name__ == "__main__":
    main(sys.argv[1:])
