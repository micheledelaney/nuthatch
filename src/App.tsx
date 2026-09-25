import { useStore, type HomeView } from "@/state/store";
import { Toolbar } from "@/components/Toolbar";
import { Navigator } from "@/components/Navigator";
import { TypeRail } from "@/components/browseA/TypeRail";
import { Workbench } from "@/components/workbench/Workbench";
import { ReportCardView } from "@/components/ReportCardView";
import { RelationshipGraphView } from "@/components/RelationshipGraphView";
import { LoadingView } from "@/components/LoadingView";
import { SavedAnalysesDashboard } from "@/components/SavedAnalysesDashboard";
import { SaveAnalysisDialog } from "@/components/SaveAnalysisDialog";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { EditDialog } from "@/components/EditDialog";
import { ComparisonView } from "@/components/ComparisonView";
import { SidebarResizer, useSidebarWidth } from "@/components/SidebarResizer";

export function App() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const model = useStore((s) => s.model);
  const comparison = useStore((s) => s.comparison);
  const view = useStore((s) => s.view);
  const showDashboard = useStore((s) => s.showDashboard);
  const hasModel = model && status !== "parsing" && !comparison && !showDashboard;
  const showSidebar = hasModel && !showDashboard && view === "browse";
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();

  return (
    <div className="app">
      <Toolbar />
      {hasModel && <MainHeader view={view} />}
      <div
        className={`workspace${showSidebar ? " with-rail" : " no-sidebar"}`}
        style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
      >
        {showSidebar && <TypeRail />}
        {showSidebar && (
          <aside className={`sidebar${sidebarWidth === 0 ? " collapsed" : ""}`}>
            {sidebarWidth > 0 && <Navigator />}
            <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} />
          </aside>
        )}
        <section className="main">
          {error && <div className="banner">{error}</div>}
          {comparison ? (
            <ComparisonView />
          ) : (!model || showDashboard) && status !== "parsing" ? (
            <SavedAnalysesDashboard />
          ) : (
            <MainContent parsing={status === "parsing"} view={view} />
          )}
        </section>
      </div>
      <SaveAnalysisDialog />
      <NewProjectDialog />
      <EditDialog />
    </div>
  );
}

function MainContent({ parsing, view }: { parsing: boolean; view: HomeView }) {
  if (parsing) {
    return (
      <LoadingView note="Reading objects, resolving references, and building the dependency graph. Large XML exports can take 15–40 seconds." />
    );
  }

  return view === "browse" ? (
    <Workbench />
  ) : view === "erd" ? (
    <RelationshipGraphView />
  ) : (
    <ReportCardView />
  );
}

function MainHeader({ view }: { view: HomeView }) {
  const setView = useStore((s) => s.setView);
  const analysisName = useStore((s) => s.analysisName);

  return (
    <nav className="main-header">
      <div className="seg-control">
        <button className={`seg-btn${view === "report" ? " active" : ""}`} onClick={() => setView("report")}>
          Report Card
        </button>
        <button className={`seg-btn${view === "browse" ? " active" : ""}`} onClick={() => setView("browse")}>
          Browse
        </button>
        <button className={`seg-btn${view === "erd" ? " active" : ""}`} onClick={() => setView("erd")}>
          ERD
        </button>
      </div>
      {analysisName && (
        <span className="analysis-name" title={analysisName}>
          {analysisName}
        </span>
      )}
    </nav>
  );
}
