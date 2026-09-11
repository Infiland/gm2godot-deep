#!/usr/bin/env python3
"""Standalone Qt companion for gm2godot-deep."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable

PINNED_COMMIT = "38b364855f06e971d2676b921fd300e1f40f076a"
REPO_URL = "https://github.com/IsmAvatar/GamemakerStudio2Godot.git"
ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "bin" / "deep-convert.mjs"


def default_settings() -> dict[str, object]:
    return {"source": "", "workspace": "", "gm2godot_checkout": "", "gm2godot_python": "", "godot_bin": "", "deep_conversion": True, "runtime": "mock", "provider": "", "model": "", "thinking": "", "token_budget": "", "cost_budget": "", "remote_upload": False, "unsafe_local": False}


def build_cli_command(args: Iterable[str], *, node: str | None = None) -> list[str]:
    return [node or os.environ.get("NODE", "node"), str(CLI), *list(args)]


def build_init_command(settings: dict[str, object]) -> list[str]:
    s = settings
    cmd = ["init", "--source", str(s.get("source", "")), "--workspace", str(s.get("workspace", ""))]
    for key, flag in (("gm2godot_checkout", "--gm2godot-checkout"), ("gm2godot_python", "--gm2godot-python"), ("godot_bin", "--godot-bin")):
        value = str(s.get(key, ""))
        if value: cmd += [flag, value]
    cmd += ["--runtime", "pi" if s.get("runtime") == "pi" else "mock"]
    return build_cli_command(cmd)


def build_plan_command(settings: dict[str, object]) -> list[str]:
    return build_cli_command(["run", "--workspace", str(settings.get("workspace", "")), "--through", "plan"])


def build_execute_command(settings: dict[str, object]) -> list[str]:
    return build_cli_command(["run", "--workspace", str(settings.get("workspace", "")), "--execute"])


def _git_head(path: str) -> list[str]:
    return ["git", "-C", path, "rev-parse", "HEAD"]

try:
    from PySide6.QtCore import QObject, QProcess, QThread, Signal, Slot
    from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDialog, QFileDialog, QFormLayout, QGridLayout, QGroupBox, QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton, QProgressBar, QSpinBox, QVBoxLayout, QWidget)
    HAVE_QT = True
except ImportError:
    HAVE_QT = False

if HAVE_QT:
    class Worker(QObject):
        output = Signal(str, bool)
        done = Signal(int)
        def __init__(self, command: list[str], cwd: str | None = None):
            super().__init__(); self.command = command; self.cwd = cwd
        @Slot()
        def run(self):
            try:
                p = subprocess.Popen(self.command, cwd=self.cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
                assert p.stdout is not None
                for line in p.stdout: self.output.emit(line.rstrip(), False)
                self.done.emit(p.wait())
            except Exception as exc: self.output.emit(str(exc), True); self.done.emit(1)

    class ReportDialog(QDialog):
        def __init__(self, text: str, parent=None):
            super().__init__(parent); self.setWindowTitle("Conversion report"); self.resize(760, 520)
            box = QVBoxLayout(self); out = QPlainTextEdit(); out.setReadOnly(True); out.setPlainText(text); box.addWidget(out)
            close = QPushButton("Close"); close.clicked.connect(self.accept); box.addWidget(close)

    class MainWindow(QMainWindow):
        def __init__(self):
            super().__init__(); self.setWindowTitle("gm2godot-deep — Deep conversion"); self.resize(880, 700); self.thread = None; self.worker = None
            self.settings = default_settings(); self._build_ui(); self._apply_theme(); self._runtime_changed()
        def _line(self, placeholder=""):
            x=QLineEdit(); x.setPlaceholderText(placeholder); return x
        def _picker(self, title, directory=True):
            row=QWidget(); lay=QHBoxLayout(row); lay.setContentsMargins(0,0,0,0); edit=self._line(); button=QPushButton("Browse…")
            def pick():
                val=QFileDialog.getExistingDirectory(self,title) if directory else QFileDialog.getOpenFileName(self,title)[0]
                if val: edit.setText(val)
            button.clicked.connect(pick); lay.addWidget(edit); lay.addWidget(button); return row, edit
        def _build_ui(self):
            root=QWidget(); outer=QVBoxLayout(root); self.setCentralWidget(root)
            settings=QGroupBox("Conversion settings"); grid=QGridLayout(settings)
            labels=[("Source project",True),("Workspace",True),("GM2Godot checkout",True),("GM2Godot Python",False),("Godot executable",False)]
            self.fields={}
            for r,(label,required) in enumerate(labels):
                grid.addWidget(QLabel(label + (" *" if required else "")),r,0); row,edit=self._picker(label, directory=label not in ("GM2Godot Python","Godot executable")); grid.addWidget(row,r,1,1,2); self.fields[label]=edit
            self.deep=QCheckBox("Deep conversion (implementation stages)"); self.deep.setChecked(True); grid.addWidget(self.deep,5,0,1,3)
            self.runtime=QComboBox(); self.runtime.addItem("Offline deterministic (mock)","mock"); self.runtime.addItem("Pi live model","pi"); grid.addWidget(QLabel("Runtime"),6,0); grid.addWidget(self.runtime,6,1,1,2)
            self.provider=self._line("Provider"); self.model=self._line("Model"); self.thinking=self._line("Thinking level")
            for r,(name,w) in enumerate((("Provider",self.provider),("Model",self.model),("Thinking",self.thinking)),7): grid.addWidget(QLabel(name),r,0); grid.addWidget(w,r,1,1,2)
            self.tokens=QSpinBox(); self.tokens.setRange(0,999999999); self.tokens.setSpecialValueText("unlimited"); self.cost=QLineEdit(); self.cost.setPlaceholderText("USD, optional")
            grid.addWidget(QLabel("Token budget"),10,0); grid.addWidget(self.tokens,10,1); grid.addWidget(QLabel("Cost budget"),10,2); grid.addWidget(self.cost,10,3)
            self.upload=QCheckBox("Allow remote upload (off by default)"); self.unsafe=QCheckBox("Allow unsafe local operations"); self.upload.setChecked(False); self.unsafe.setChecked(False); grid.addWidget(self.upload,11,0,1,2); grid.addWidget(self.unsafe,11,2,1,2)
            outer.addWidget(settings)
            actions=QHBoxLayout(); self.doctor=QPushButton("Preflight / doctor"); self.run=QPushButton("Run Deep conversion"); self.implement=QPushButton("Run implementation + validation"); self.status=QPushButton("Refresh status"); self.report=QPushButton("Open report"); self.run.setEnabled(False); self.implement.setEnabled(False)
            for b in (self.doctor,self.run,self.implement,self.status,self.report): actions.addWidget(b)
            outer.addLayout(actions); self.stage=QProgressBar(); self.stage.setRange(0,7); self.stage.setValue(0); self.stage.setFormat("Ready"); outer.addWidget(self.stage)
            self.log=QPlainTextEdit(); self.log.setReadOnly(True); outer.addWidget(self.log,1)
            self.runtime.currentIndexChanged.connect(self._runtime_changed); self.doctor.clicked.connect(self.preflight); self.run.clicked.connect(self.start_run); self.implement.clicked.connect(self.start_implementation); self.status.clicked.connect(self.refresh_status); self.report.clicked.connect(self.open_report)
            self._plan_ready=False
            self._apply_theme()
        def _apply_theme(self):
            self.setStyleSheet("QWidget{background:#171a21;color:#e8edf2;font-size:13px} QGroupBox{border:1px solid #394252;border-radius:8px;margin-top:10px;padding:10px} QGroupBox::title{color:#77c8ff;subcontrol-origin:margin;left:10px;padding:0 4px} QLineEdit,QComboBox,QSpinBox,QPlainTextEdit{background:#202631;border:1px solid #3d4858;border-radius:5px;padding:5px} QPushButton{background:#2d77a8;border:0;border-radius:5px;padding:7px 12px} QPushButton:hover{background:#4095ca} QProgressBar{height:18px;border-radius:5px;text-align:center} QProgressBar::chunk{background:#41b883;border-radius:5px}")
        def _runtime_changed(self):
            live=self.runtime.currentData()=="pi"
            for w in (self.provider,self.model,self.thinking): w.setEnabled(live)
        def _settings(self):
            return {"source":self.fields["Source project"].text(),"workspace":self.fields["Workspace"].text(),"gm2godot_checkout":self.fields["GM2Godot checkout"].text(),"gm2godot_python":self.fields["GM2Godot Python"].text(),"godot_bin":self.fields["Godot executable"].text(),"runtime":self.runtime.currentData()}
        def _append(self,text,error=False): self.log.appendPlainText(f"[{datetime.now().strftime('%H:%M:%S')}] {'ERROR: ' if error else ''}{text}")
        def _start(self,cmd,stage,cwd=None,callback=None):
            labels=["Ready","Preflight","Source snapshot / initialization","GM2Godot baseline + analysis + plan","Implementation + validation","Report"]
            self.stage.setValue(min(stage, self.stage.maximum())); self.stage.setFormat(labels[min(stage, len(labels)-1)]); self._append("$ "+" ".join(cmd)); self.thread=QThread(); self.worker=Worker(cmd,cwd); self.worker.moveToThread(self.thread); self.thread.started.connect(self.worker.run); self.worker.output.connect(self._append); self.worker.done.connect(lambda code: self._finished(code,callback)); self.worker.done.connect(self.thread.quit); self.thread.finished.connect(self.thread.deleteLater); self.thread.start()
            self._append(f"finished with exit code {code}")
            if callback:
                callback(code)
            else:
                self._plan_ready = code == 0
                self.run.setEnabled(code == 0 and bool(self.fields["Workspace"].text()))
                self.implement.setEnabled(self._plan_ready and self.deep.isChecked())
                self.doctor.setEnabled(True)
                self.status.setEnabled(True)
                self.report.setEnabled(True)
        def preflight(self):
            s=self._settings(); checkout=s["gm2godot_checkout"]
            if not checkout or not Path(checkout).is_dir():
                box=QMessageBox(self); box.setWindowTitle("GM2Godot checkout required"); box.setText("A GM2Godot checkout is required for preflight."); select=box.addButton("Select checkout",QMessageBox.AcceptRole); install=box.addButton("Install pinned checkout",QMessageBox.ActionRole); box.addButton("Cancel",QMessageBox.RejectRole); box.exec()
                if box.clickedButton() is select:
                    val=QFileDialog.getExistingDirectory(self,"Select GM2Godot checkout");
                    if val:self.fields["GM2Godot checkout"].setText(val)
                elif box.clickedButton() is install:self.install_checkout()
                return
            self._start(build_cli_command(["doctor","--workspace",s["workspace"]]),1)
        def install_checkout(self):
            dest=QFileDialog.getExistingDirectory(self,"Choose installation destination")
            if not dest:return
            target=str(Path(dest)/"gm2godot")
            msg=f"Install pinned checkout?\n\nRepository: {REPO_URL}\nCommit: {PINNED_COMMIT}\nLicense: Apache-2.0\nDestination: {target}"
            if QMessageBox.question(self,"Confirm installation",msg,QMessageBox.Yes|QMessageBox.No)!=QMessageBox.Yes:return
            self._start(["git","clone",REPO_URL,target],1,callback=lambda code: self._install_checkout_done(code,target))
        def _install_checkout_done(self, code, target):
            if code != 0: return
            self._start(["git","-C",target,"checkout","--detach",PINNED_COMMIT],1,callback=lambda result: self._verify_checkout(result,target))
        def _verify_checkout(self, code, target):
            if code != 0: return
            self._start(_git_head(target),1,callback=lambda result: self._checkout_verified(result,target))
        def _checkout_verified(self, code, target):
            if code == 0:
                self.fields["GM2Godot checkout"].setText(target)
                self._append("Pinned checkout verified: "+PINNED_COMMIT)
        def start_run(self):
            s=self._settings()
            if not self.deep.isChecked():
                QMessageBox.information(self,"Deep conversion disabled","Enable Deep conversion before starting the pipeline.")
                return
            if not s["workspace"] or not s["source"]: QMessageBox.warning(self,"Project required","Choose a source project and workspace first."); return
            if not s["gm2godot_checkout"] or not Path(str(s["gm2godot_checkout"])).is_dir():
                QMessageBox.warning(self,"GM2Godot required","Run Preflight / doctor and select the pinned GM2Godot checkout first."); return
            mode = "Offline deterministic — no model/provider exercised" if self.runtime.currentData()=="mock" else "Pi live model — provider/model will be used"
            consent = ("This creates an immutable source snapshot and invokes the external pinned GM2Godot tool.\n\n"
                       f"Mode: {mode}\nCredentials stay out of project artifacts. Remote upload is off by default.\n\n"
                       "Continue through analysis and planning only?")
            if QMessageBox.question(self,"Consent: Deep conversion",consent,QMessageBox.Yes|QMessageBox.No)!=QMessageBox.Yes:return
            if self.runtime.currentData()=="pi" and (not self.provider.text() or not self.model.text()): QMessageBox.warning(self,"Live model settings","Provider and model are required for Pi live model."); return
            if self.runtime.currentData()=="pi" and self.upload.isChecked() and QMessageBox.question(self,"Confirm remote upload","Allow assigned project data to be uploaded to the configured provider? Unrelated files and credentials are excluded.",QMessageBox.Yes|QMessageBox.No)!=QMessageBox.Yes:return
            self._plan_ready=False; self.implement.setEnabled(False)
            self._start(build_init_command(s),2,callback=lambda code: self._plan_after_init(code,s))
        def _plan_after_init(self, code, settings):
            if code != 0: return
            self._start(build_plan_command(settings),3,callback=lambda result: self._plan_finished(result,settings))
        def _plan_finished(self, code, settings):
            self._plan_ready = code == 0
            self._append("Offline deterministic — no model/provider exercised" if settings.get("runtime")=="mock" else "Plan ready; Pi implementation remains opt-in")
            self.implement.setEnabled(self._plan_ready and self.deep.isChecked())
        def start_implementation(self):
            if not self.deep.isChecked():
                QMessageBox.information(self,"Deep conversion disabled","Enable Deep conversion before starting implementation.")
                return
            if not self._plan_ready:
                QMessageBox.information(self,"Plan required","Run Deep conversion through the plan stage first.")
                return
            if self.unsafe.isChecked() and QMessageBox.question(self,"Confirm unsafe local mode","UNSAFE LOCAL MODE disables process isolation. Continue?",QMessageBox.Yes|QMessageBox.No)!=QMessageBox.Yes:return
            if QMessageBox.question(self,"Confirm implementation","This will modify the port workspace and run implementation plus validation. Continue?",QMessageBox.Yes|QMessageBox.No)!=QMessageBox.Yes:return
            self._start(build_execute_command(self._settings()),4)
        def open_report(self):
            p=Path(self.fields["Workspace"].text())/"evidence"/"reports"/"report.md"
            if not p.exists(): QMessageBox.information(self,"Report","No evidence report has been generated yet."); return
            ReportDialog(p.read_text(encoding="utf-8"),self).exec()

def self_check() -> int:
    s=default_settings(); assert s["runtime"]=="mock" and s["deep_conversion"] is True and not s["remote_upload"] and not s["unsafe_local"]
    assert "--runtime" in build_init_command(s) and "mock" in build_init_command(s)
    assert build_plan_command(s)[-1]=="plan" and "--execute" not in build_plan_command(s)
    assert "--execute" in build_execute_command(s)
    print("GUI_SELF_CHECK_OK"); return 0

if __name__ == "__main__":
    if "--self-check" in sys.argv: raise SystemExit(self_check())
    if not HAVE_QT: print("PySide6 is required; install it in the GM2Godot campaign venv.", file=sys.stderr); raise SystemExit(2)
    app=QApplication(sys.argv); win=MainWindow(); win.show(); raise SystemExit(app.exec())
