output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "vpc_id" {
  value = module.vpc.vpc_id
}

# output "alb_dns_name" { value = aws_lb.main.dns_name }
# output "database_endpoint" { value = aws_rds_cluster.pg.endpoint }
# output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
