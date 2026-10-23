# Dedicated minimal OCI public-subnet VM, not a full public application edge.
# Only SSH from admin_ssh_ipv4_cidr is admitted. Docker services stay internal.
# Always Free status MUST be checked on the actual tenancy before apply.
resource "terraform_data" "preflight_gate" {
  input = "always-free-verified"

  lifecycle {
    precondition {
      condition     = var.home_region_verified && var.always_free_quota_verified && var.no_existing_instance_or_network_conflict
      error_message = "STOP: verify tenancy HOME region, remaining Always Free quota, and existing resource conflicts before any creation."
    }
    precondition {
      condition     = fileexists(pathexpand(var.ssh_public_key_path))
      error_message = "STOP: SSH public key does not exist at supplied local path."
    }
    precondition {
      condition     = can(regex("^ssh-(ed25519|rsa) ", trimspace(file(pathexpand(var.ssh_public_key_path)))))
      error_message = "STOP: key file is not a recognizable SSH PUBLIC KEY."
    }
  }
}

resource "oci_core_vcn" "whatsapp" {
  depends_on     = [terraform_data.preflight_gate]
  compartment_id = var.compartment_ocid
  display_name   = "vcn-whatsapp-ai"
  cidr_blocks    = ["10.84.0.0/16"]
  dns_label      = "whatsappai"
  freeform_tags  = { "project" = "WHATSAPP_AI", "billing-intent" = "always-free" }
}

resource "oci_core_internet_gateway" "whatsapp" {
  depends_on     = [terraform_data.preflight_gate]
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.whatsapp.id
  display_name   = "igw-whatsapp-ai"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  depends_on     = [terraform_data.preflight_gate]
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.whatsapp.id
  display_name   = "rt-whatsapp-ai-public"

  route_rules {
    network_entity_id = oci_core_internet_gateway.whatsapp.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

resource "oci_core_security_list" "ssh_only" {
  depends_on     = [terraform_data.preflight_gate]
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.whatsapp.id
  display_name   = "sl-whatsapp-ai-ssh-only"

  ingress_security_rules {
    protocol    = "6"
    source      = var.admin_ssh_ipv4_cidr
    source_type = "CIDR_BLOCK"
    description = "SSH from explicitly approved administrator IPv4 only"
    stateless   = false
    tcp_options {
      min = 22
      max = 22
    }
  }

  egress_security_rules {
    protocol         = "all"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    description      = "Outbound package download and authorized services"
    stateless        = false
  }
}

resource "oci_core_subnet" "public" {
  depends_on                 = [terraform_data.preflight_gate]
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.whatsapp.id
  display_name               = "subnet-whatsapp-ai-public"
  cidr_block                 = "10.84.1.0/24"
  dns_label                  = "public"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.ssh_only.id]
}

resource "oci_core_instance" "whatsapp" {
  depends_on          = [terraform_data.preflight_gate]
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = "whatsapp-ai-fretes"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = 2
    memory_in_gbs = 12
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    hostname_label   = "whatsapp-ai"
  }

  source_details {
    source_type             = "image"
    source_id               = var.ubuntu_arm64_image_ocid
    boot_volume_size_in_gbs = 50
    boot_volume_vpus_per_gb = 10
  }

  metadata = {
    ssh_authorized_keys = trimspace(file(pathexpand(var.ssh_public_key_path)))
  }

  freeform_tags = {
    "project"        = "WHATSAPP_AI"
    "billing-intent" = "always-free"
    "workload"       = "freight-only"
  }

  # Terraform destroy would remove the VM; never do this casually.
  lifecycle {
    prevent_destroy = true
  }
}
