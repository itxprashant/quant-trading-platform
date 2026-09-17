terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # Configure a remote backend before use, e.g.:
  # backend "s3" {
  #   bucket = "quanta-tfstate"
  #   key    = "platform/terraform.tfstate"
  #   region = "ap-south-1"
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project = "quanta"
      Env     = var.environment
    }
  }
}
