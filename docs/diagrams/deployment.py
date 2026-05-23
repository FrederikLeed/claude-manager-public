from diagrams import Diagram, Cluster, Edge
from diagrams.onprem.compute import Server
from diagrams.onprem.container import Docker
from diagrams.onprem.client import Users
from diagrams.onprem.database import PostgreSQL
from diagrams.generic.network import Firewall
from diagrams.generic.storage import Storage
from diagrams.generic.compute import Rack

graph_attr = {
    "bgcolor": "#FAFAFA",
    "pad": "0.4",
    "fontname": "Helvetica",
    "fontsize": "16",
    "splines": "ortho",
}
node_attr = {"fontname": "Helvetica", "fontsize": "11"}
edge_attr = {"fontname": "Helvetica", "fontsize": "9"}

with Diagram(
    "Claude Manager — Deployment",
    filename="deployment",
    outformat="png",
    show=False,
    direction="TB",
    graph_attr=graph_attr,
    node_attr=node_attr,
    edge_attr=edge_attr,
):
    users = Users("Operators")

    with Cluster("Host (claude-manager-net bridge)"):
        docker = Docker("Docker Engine")

        with Cluster("Manager"):
            manager = Server("claude-manager\nFastify 5 + React 19\n:3002")
            db = Storage("manager.db\nSQLite + WAL")
            manager - db

        with Cluster("Sidecars"):
            proxy = Firewall("cm-proxy\nsquid forward proxy")
            litellm = Server("cm-litellm\nLiteLLM router\n:4000")
            ollama = Rack("cm-ollama\nQwen3 30B-A3B\nLocal GPU")
            pgdb = PostgreSQL("cm-litellm-db\nvirtual keys")

        with Cluster("Workspace instances (cm-instance-*)"):
            inst_a = Server("customer-a\nclaude-only + claude-max")
            inst_b = Server("docs-writer\nunrestricted + local-llm")
            inst_c = Server("ad-security\nclaude-github + foundry")

        with Cluster("Bind-mounted host dirs (git-tracked)"):
            shared = Storage("data/shared/")
            home = Storage("data/claude-home/")
            memory = Storage("data/instance-memory/")
            policies = Storage("workspace/policies/\n(YAML, RO)")

        with Cluster("Docker volumes (not git-tracked)"):
            acl_vol = Storage("proxy-acl")
            ollama_vol = Storage("ollama-data")
            pgvol = Storage("litellm-db")

    users >> Edge(label="HTTPS :3002 + WebSocket") >> manager
    manager >> Edge(label="docker.sock", color="#E65100") >> docker
    docker >> Edge(label="lifecycle", color="#E65100") >> [inst_a, inst_b, inst_c]

    manager >> Edge(label="writes ACLs", style="dashed", color="#C62828") >> acl_vol
    acl_vol >> Edge(style="dashed", color="#C62828") >> proxy

    inst_a >> Edge(label="HTTPS_PROXY", color="#C62828") >> proxy
    inst_b >> Edge(label="ANTHROPIC_BASE_URL", color="#E65100") >> litellm
    inst_c >> Edge(label="HTTPS_PROXY", color="#C62828") >> proxy

    litellm >> Edge(label="Claude aliases → Qwen3", color="#E65100") >> ollama
    litellm - Edge(style="dashed") - pgdb
    pgdb - Edge(style="invis") - pgvol
    ollama - Edge(style="invis") - ollama_vol

    shared >> Edge(style="dashed", label="/shared") >> inst_a
    home >> Edge(style="dashed", label="~/.claude") >> inst_a
    memory >> Edge(style="dashed", label="/workspace/.claude") >> inst_a
    policies >> Edge(style="dashed", label="/policies (RO)") >> manager
