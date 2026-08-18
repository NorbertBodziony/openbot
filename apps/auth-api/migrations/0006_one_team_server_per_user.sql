DROP INDEX team_tunnels_user_id;
CREATE UNIQUE INDEX team_tunnels_user_id ON team_tunnels(user_id);
