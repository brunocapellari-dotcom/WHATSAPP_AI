terraform {
  required_version = ">= 1.5.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 6.0.0, < 8.0.0"
    }
  }
}

# Use existing authenticated OCI CLI configuration or OCI_* environment variables.
# No cloud credentials, private keys, state files or live IPs belong in Git.
provider "oci" {
  region = var.region
}
