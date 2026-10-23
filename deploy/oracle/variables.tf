variable "compartment_ocid" {
  description = "OCI compartment in the tenancy's HOME region."
  type        = string
  validation {
    condition     = startswith(var.compartment_ocid, "ocid1.compartment.") || startswith(var.compartment_ocid, "ocid1.tenancy.")
    error_message = "Supply an actual compartment or tenancy OCID."
  }
}

variable "region" {
  description = "Home region identifier, e.g. sa-santiago-1. Verify using OCI CLI."
  type        = string
  validation {
    condition     = length(trimspace(var.region)) > 3
    error_message = "Region must be explicitly supplied."
  }
}

variable "availability_domain" {
  description = "Availability domain NAME confirmed to support VM.Standard.A1.Flex."
  type        = string
  validation {
    condition     = length(trimspace(var.availability_domain)) > 3
    error_message = "Provide a confirmed availability domain."
  }
}

variable "ubuntu_arm64_image_ocid" {
  description = "Verified Canonical Ubuntu ARM64 image OCID in the HOME region."
  type        = string
  validation {
    condition     = startswith(var.ubuntu_arm64_image_ocid, "ocid1.image.")
    error_message = "Provide the actual ARM64 image OCID; do not guess."
  }
}

variable "ssh_public_key_path" {
  description = "LOCAL PATH to an existing SSH .pub key; NEVER a private key."
  type        = string
  validation {
    condition     = endswith(var.ssh_public_key_path, ".pub")
    error_message = "The SSH key path must end in .pub."
  }
}

variable "admin_ssh_ipv4_cidr" {
  description = "Trusted current public IPv4 address /32; 0.0.0.0/0 is prohibited."
  type        = string
  validation {
    condition     = can(cidrhost(var.admin_ssh_ipv4_cidr, 0)) && endswith(var.admin_ssh_ipv4_cidr, "/32")
    error_message = "SSH ingress MUST use exactly one trusted IPv4 address (/32)."
  }
}

variable "home_region_verified" {
  description = "Set only after verifying tenancy home region equals var.region."
  type        = bool
  default     = false
}

variable "always_free_quota_verified" {
  description = "Set only after checking existing A1 compute, storage, public IP and tenancy charges."
  type        = bool
  default     = false
}

variable "no_existing_instance_or_network_conflict" {
  description = "Set only after checking OCI Console/CLI for resources to reuse/import."
  type        = bool
  default     = false
}
