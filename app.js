(function () {
  "use strict";

  var $ = function (selector) {
    return document.querySelector(selector);
  };

  var $$ = function (selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  };

  var state = {
    file: null,
    bytes: null,
    pdfDoc: null,
    pdfjsDoc: null,
    pageCount: 0,
    currentPage: 0,
    currentAnnotations: [],
    currentViewport: null,
    pageSizes: [],
    formFields: [],
    marks: [],
    activeTool: "",
    selectedMarkId: "",
    markCounter: 1,
    signatureDirty: false,
    inkTool: "",
    savedSignatureDataUrl: "",
    savedSignatureAspect: 0.32,
    savedInitialsDataUrl: "",
    savedInitialsAspect: 0.42,
    dragging: null,
    resizing: null,
    busy: false
  };
  var textMarkMeasurer = null;

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.PDFLib || !window.pdfjsLib) {
      setStatus("PDF engine did not load", "danger");
      return;
    }

    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "assets/vendor/pdf.worker.min.js";
    bindEvents();
    initSignaturePad();
    setDefaultDate();
    setTool(state.activeTool);
    syncControls();
  });

  function bindEvents() {
    $("#fileInput").addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (file) {
        loadPdf(file);
      }
    });

    $("#dropZone").addEventListener("dragover", function (event) {
      event.preventDefault();
      $("#dropZone").classList.add("dragging");
    });
    $("#dropZone").addEventListener("dragleave", function () {
      $("#dropZone").classList.remove("dragging");
    });
    $("#dropZone").addEventListener("drop", function (event) {
      event.preventDefault();
      $("#dropZone").classList.remove("dragging");
      var file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) {
        loadPdf(file);
      }
    });

    $$(".tool-card").forEach(function (button) {
      button.addEventListener("click", function () {
        handleToolButtonClick(button.dataset.tool);
      });
    });

    $("#prevPage").addEventListener("click", function () {
      setPage(state.currentPage - 1);
    });
    $("#nextPage").addEventListener("click", function () {
      setPage(state.currentPage + 1);
    });
    $("#pageRail").addEventListener("click", function (event) {
      var button = event.target.closest("[data-page-index]");
      if (button) {
        setPage(Number(button.dataset.pageIndex));
      }
    });

    $("#pageCanvasWrap").addEventListener("click", handleStageClick);
    $("#overlayLayer").addEventListener("click", handleOverlayClick);
    $("#overlayLayer").addEventListener("input", handleOverlayInput);
    $("#overlayLayer").addEventListener("change", handleOverlayInput);
    $("#overlayLayer").addEventListener("pointerdown", handleMarkPointerDown);
    window.addEventListener("pointermove", handleMarkPointerMove);
    window.addEventListener("pointerup", handleMarkPointerUp);
    window.addEventListener("keydown", handleKeydown);

    $("#fillForm").addEventListener("input", handleFormInput);
    $("#fillForm").addEventListener("change", handleFormInput);
    $("#markSize").addEventListener("input", handleToolbarInput);
    $("#markSize").addEventListener("change", handleToolbarInput);
    $("#signatureScale").addEventListener("input", handleToolbarInput);
    $("#signatureScale").addEventListener("change", handleToolbarInput);
    $("#markColor").addEventListener("input", handleToolbarInput);
    $("#markColor").addEventListener("change", handleToolbarInput);
    $("#fieldList").addEventListener("input", handleFieldInput);
    $("#fieldList").addEventListener("change", handleFieldInput);

    $("#deleteMark").addEventListener("click", deleteSelectedMark);
    $("#downloadPdf").addEventListener("click", downloadFilledPdf);
    $("#toggleDetails").addEventListener("click", toggleDetails);
    $("#resetAll").addEventListener("click", resetAll);

    window.addEventListener("resize", debounce(function () {
      if (state.pdfjsDoc) {
        renderCurrentPage();
      }
    }, 150));
  }

  async function loadPdf(file) {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setStatus("Use a PDF file", "warn");
      return;
    }

    setBusy(true, "Reading PDF");
    resetDocument(false);

    try {
      var buffer = await file.arrayBuffer();
      state.file = file;
      state.bytes = new Uint8Array(buffer);
      state.pdfDoc = await window.PDFLib.PDFDocument.load(state.bytes, {
        ignoreEncryption: true,
        updateMetadata: false
      });
      state.pdfjsDoc = await window.pdfjsLib.getDocument({
        data: state.bytes.slice(0),
        disableFontFace: true
      }).promise;
      state.pageCount = state.pdfDoc.getPageCount();
      state.pageSizes = state.pdfDoc.getPages().map(function (page) {
        var size = page.getSize();
        return { width: size.width, height: size.height };
      });
      state.formFields = readFormFields(state.pdfDoc);
      await collectAnnotationFields();
      state.currentPage = 0;
      $("#outputName").value = makeOutputName(file.name);
      renderFieldList();
      renderPageRail();
      await renderCurrentPage();
      setBusy(false, "Ready");
    } catch (error) {
      setBusy(false, getErrorMessage(error), "danger");
      resetDocument(false);
    }
    syncControls();
  }

  async function collectAnnotationFields() {
    if (!state.pdfjsDoc) {
      return;
    }
    for (var index = 0; index < state.pageCount; index += 1) {
      try {
        var page = await state.pdfjsDoc.getPage(index + 1);
        var annotations = await page.getAnnotations({ intent: "display" });
        annotations.filter(isFillableAnnotation).forEach(ensureAnnotationField);
      } catch (error) {
        // A page without readable annotations can still be filled with marks.
      }
    }
  }

  function readFormFields(pdfDoc) {
    var form;
    try {
      form = pdfDoc.getForm();
    } catch (error) {
      return [];
    }

    return form.getFields().map(function (field, index) {
      var name = field.getName();
      var type = getFieldType(field);
      var value = "";
      var options = [];
      var checked = false;

      try {
        if (type === "text") {
          value = field.getText() || "";
        } else if (type === "checkbox") {
          checked = field.isChecked();
        } else if (type === "dropdown" || type === "radio" || type === "optionlist") {
          options = field.getOptions ? field.getOptions() : [];
          var selected = field.getSelected ? field.getSelected() : "";
          value = Array.isArray(selected) ? selected[0] || "" : selected || "";
        }
      } catch (error) {
        value = "";
      }

      return {
        id: "field-" + index,
        name: name,
        type: type,
        value: value,
        checked: checked,
        options: options
      };
    });
  }

  function getFieldType(field) {
    var PDFLib = window.PDFLib;
    if (PDFLib.PDFTextField && field instanceof PDFLib.PDFTextField) {
      return "text";
    }
    if (PDFLib.PDFCheckBox && field instanceof PDFLib.PDFCheckBox) {
      return "checkbox";
    }
    if (PDFLib.PDFDropdown && field instanceof PDFLib.PDFDropdown) {
      return "dropdown";
    }
    if (PDFLib.PDFRadioGroup && field instanceof PDFLib.PDFRadioGroup) {
      return "radio";
    }
    if (PDFLib.PDFOptionList && field instanceof PDFLib.PDFOptionList) {
      return "optionlist";
    }
    return "unknown";
  }

  function isFillableAnnotation(annotation) {
    if (!annotation || annotation.subtype !== "Widget" || !annotation.fieldName || !Array.isArray(annotation.rect) || annotation.readOnly) {
      return false;
    }
    return getAnnotationFieldType(annotation) !== "unknown";
  }

  function ensureAnnotationField(annotation) {
    if (!isFillableAnnotation(annotation)) {
      return null;
    }

    var field = getFieldByName(annotation.fieldName);
    var type = getAnnotationFieldType(annotation);
    var options = getAnnotationOptions(annotation);

    if (!field) {
      if (type === "radio") {
        options = mergeOptions(options, [getAnnotationButtonValue(annotation)]);
      }
      field = {
        id: "annotation-field-" + state.formFields.length,
        name: annotation.fieldName,
        type: type,
        value: getAnnotationValue(annotation, type),
        checked: getAnnotationChecked(annotation),
        options: options
      };
      state.formFields.push(field);
      return field;
    }

    if (field.type === "unknown" && type !== "unknown") {
      field.type = type;
    }
    if (type === "radio" && !field.options.length) {
      options = mergeOptions(options, [getAnnotationButtonValue(annotation)]);
    }
    field.options = mergeOptions(field.options, options);
    if (type === "checkbox") {
      field.checked = field.checked || getAnnotationChecked(annotation);
    } else if (!field.value && getAnnotationValue(annotation, type)) {
      field.value = getAnnotationValue(annotation, type);
    }
    return field;
  }

  function getAnnotationFieldType(annotation) {
    if (annotation.fieldType === "Tx") {
      return "text";
    }
    if (annotation.fieldType === "Btn") {
      if (annotation.radioButton) {
        return "radio";
      }
      if (annotation.checkBox || annotation.buttonValue) {
        return "checkbox";
      }
      return "unknown";
    }
    if (annotation.fieldType === "Ch") {
      return annotation.combo ? "dropdown" : "optionlist";
    }
    return "unknown";
  }

  function getAnnotationOptions(annotation) {
    return (annotation.options || []).map(function (option) {
      if (typeof option === "string") {
        return option;
      }
      return String(option.displayValue || option.exportValue || option.value || "");
    }).filter(Boolean);
  }

  function getAnnotationValue(annotation, type) {
    if (type === "checkbox") {
      return "";
    }
    var value = annotation.fieldValue;
    if (Array.isArray(value)) {
      return value.length ? String(value[0]) : "";
    }
    if (value === null || value === undefined || value === "Off") {
      return "";
    }
    return String(value);
  }

  function getAnnotationChecked(annotation) {
    var value = annotation.fieldValue;
    if (value === null || value === undefined) {
      return false;
    }
    value = String(value);
    return value !== "" && value !== "Off";
  }

  function getAnnotationButtonValue(annotation) {
    return String(annotation.buttonValue || annotation.exportValue || "Yes");
  }

  function getRadioOverlayValue(annotation, field) {
    if (field && field.options && field.options.length) {
      var siblings = state.currentAnnotations.filter(function (item) {
        return item.fieldName === annotation.fieldName && getAnnotationFieldType(item) === "radio";
      });
      var index = siblings.indexOf(annotation);
      if (field.options[index]) {
        return field.options[index];
      }
    }
    return getAnnotationButtonValue(annotation);
  }

  function mergeOptions(base, extra) {
    var merged = [];
    (base || []).concat(extra || []).forEach(function (option) {
      option = String(option || "");
      if (option && merged.indexOf(option) === -1) {
        merged.push(option);
      }
    });
    return merged;
  }

  function getFieldByName(name) {
    return state.formFields.find(function (field) {
      return field.name === name;
    });
  }

  function renderFieldList() {
    var list = $("#fieldList");
    if (!state.formFields.length) {
      list.innerHTML = '<div class="subtle-box">No fillable PDF form fields were detected. Use the tools above to place text, checkmarks, dates, initials, and signatures.</div>';
      return;
    }

    list.innerHTML = state.formFields.map(function (field) {
      if (field.type === "checkbox") {
        return '<div class="field-row checkbox" data-field-id="' + escapeAttr(field.id) + '">' +
          '<input type="checkbox" data-field-value' + (field.checked ? " checked" : "") + ">" +
          '<div><strong>' + escapeText(field.name) + '</strong><label>Checkbox</label></div>' +
        "</div>";
      }
      if ((field.type === "dropdown" || field.type === "radio" || field.type === "optionlist") && field.options.length) {
        return '<div class="field-row" data-field-id="' + escapeAttr(field.id) + '">' +
          '<strong>' + escapeText(field.name) + '</strong><label>' + escapeText(field.type) + "</label>" +
          '<select data-field-value>' + field.options.map(function (option) {
            return '<option value="' + escapeAttr(option) + '"' + (option === field.value ? " selected" : "") + ">" + escapeText(option) + "</option>";
          }).join("") + "</select>" +
        "</div>";
      }
      if (field.type === "unknown") {
        return '<div class="field-row" data-field-id="' + escapeAttr(field.id) + '">' +
          '<strong>' + escapeText(field.name) + '</strong><label>Unsupported field type</label>' +
          '<input type="text" data-field-value disabled value="Use a freeform mark instead">' +
        "</div>";
      }
      return '<div class="field-row" data-field-id="' + escapeAttr(field.id) + '">' +
        '<strong>' + escapeText(field.name) + '</strong><label>Text field</label>' +
        '<input type="text" data-field-value value="' + escapeAttr(field.value) + '">' +
      "</div>";
    }).join("");
  }

  function handleFieldInput(event) {
    var row = event.target.closest("[data-field-id]");
    if (!row) {
      return;
    }
    var field = state.formFields.find(function (item) {
      return item.id === row.dataset.fieldId;
    });
    if (!field) {
      return;
    }
    var input = row.querySelector("[data-field-value]");
    if (field.type === "checkbox") {
      field.checked = input.checked;
    } else if (field.type === "radio") {
      field.value = input.value;
    } else {
      field.value = input.value;
    }
    updateOverlayFieldInput(field);
    updateStats();
  }

  function updateFieldListInput(field) {
    var row = getFieldRow(field.id);
    var input = row && row.querySelector("[data-field-value]");
    if (!input) {
      return;
    }
    if (field.type === "checkbox") {
      input.checked = field.checked;
    } else {
      input.value = field.value || "";
    }
  }

  function updateOverlayFieldInput(field, skipInput) {
    $$("[data-overlay-field]").forEach(function (input) {
      if (input === skipInput || input.dataset.overlayField !== field.name) {
        return;
      }
      if (field.type === "checkbox") {
        input.checked = field.checked;
      } else if (field.type === "radio") {
        input.checked = input.dataset.overlayValue === field.value;
      } else {
        input.value = field.value || "";
      }
    });
  }

  function getFieldRow(id) {
    return $$(".field-row").find(function (row) {
      return row.dataset.fieldId === id;
    });
  }

  async function renderPageRail() {
    var rail = $("#pageRail");
    rail.innerHTML = "";
    for (var index = 0; index < state.pageCount; index += 1) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "page-thumb" + (index === state.currentPage ? " active" : "");
      button.dataset.pageIndex = String(index);
      button.innerHTML = '<canvas aria-hidden="true"></canvas><span>Page ' + (index + 1) + "</span>";
      rail.appendChild(button);
      renderThumb(index, button.querySelector("canvas"));
    }
  }

  async function renderThumb(pageIndex, canvas) {
    try {
      var page = await state.pdfjsDoc.getPage(pageIndex + 1);
      var viewport = page.getViewport({ scale: 0.18 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      var context = canvas.getContext("2d");
      await page.render({ canvasContext: context, viewport: viewport }).promise;
    } catch (error) {
      canvas.replaceWith(document.createTextNode("Preview"));
    }
  }

  async function renderCurrentPage() {
    if (!state.pdfjsDoc) {
      return;
    }
    $("#emptyState").hidden = true;
    $("#pageStage").hidden = false;

    var page = await state.pdfjsDoc.getPage(state.currentPage + 1);
    var base = page.getViewport({ scale: 1 });
    var maxWidth = Math.min(920, Math.max(320, $("#pageStage").clientWidth - 24));
    var scale = Math.min(1.7, maxWidth / Math.max(1, base.width));
    var viewport = page.getViewport({ scale: scale });
    state.currentViewport = viewport;
    var canvas = $("#pageCanvas");
    var context = canvas.getContext("2d");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = Math.ceil(viewport.width) + "px";
    canvas.style.height = Math.ceil(viewport.height) + "px";
    $("#pageCanvasWrap").style.width = canvas.style.width;
    $("#pageCanvasWrap").style.height = canvas.style.height;
    $("#overlayLayer").style.width = canvas.style.width;
    $("#overlayLayer").style.height = canvas.style.height;
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    try {
      state.currentAnnotations = (await page.getAnnotations({ intent: "display" })).filter(isFillableAnnotation);
      state.currentAnnotations.forEach(ensureAnnotationField);
    } catch (error) {
      state.currentAnnotations = [];
    }
    renderOverlay(viewport);
    updatePageActiveState();
  }

  function updatePageActiveState() {
    $$(".page-thumb").forEach(function (button) {
      button.classList.toggle("active", Number(button.dataset.pageIndex) === state.currentPage);
    });
  }

  function renderOverlay(viewport) {
    var layer = $("#overlayLayer");
    layer.innerHTML = renderFieldOverlays(viewport) + renderMarksHtml();
  }

  function renderOverlayFromCurrent() {
    renderOverlay(state.currentViewport);
  }

  function renderFieldOverlays(viewport) {
    if (!viewport) {
      return "";
    }
    return state.currentAnnotations.map(function (annotation) {
      var field = ensureAnnotationField(annotation);
      if (!field || field.type === "unknown") {
        return "";
      }

      var rect = viewport.convertToViewportRectangle(annotation.rect);
      var left = Math.min(rect[0], rect[2]);
      var top = Math.min(rect[1], rect[3]);
      var width = Math.abs(rect[2] - rect[0]);
      var height = Math.abs(rect[3] - rect[1]);
      var style = "left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height + "px;";

      if (field.type === "checkbox") {
        return '<input class="field-overlay checkbox" type="checkbox" data-overlay-field="' + escapeAttr(field.name) + '" style="' + style + '"' + (field.checked ? " checked" : "") + ' title="' + escapeAttr(field.name) + '">';
      }

      if (field.type === "radio") {
        var radioValue = getRadioOverlayValue(annotation, field);
        var radioName = "overlay-radio-" + field.id;
        return '<input class="field-overlay checkbox radio" type="radio" name="' + escapeAttr(radioName) + '" data-overlay-field="' + escapeAttr(field.name) + '" data-overlay-value="' + escapeAttr(radioValue) + '" style="' + style + '"' + (field.value === radioValue ? " checked" : "") + ' title="' + escapeAttr(field.name) + '">';
      }

      if ((field.type === "dropdown" || field.type === "radio" || field.type === "optionlist") && field.options.length) {
        return '<select class="field-overlay select" data-overlay-field="' + escapeAttr(field.name) + '" style="' + style + '" title="' + escapeAttr(field.name) + '">' +
          field.options.map(function (option) {
            return '<option value="' + escapeAttr(option) + '"' + (option === field.value ? " selected" : "") + ">" + escapeText(option) + "</option>";
          }).join("") +
        "</select>";
      }

      if (annotation.multiLine) {
        return '<textarea class="field-overlay text multiline" data-overlay-field="' + escapeAttr(field.name) + '" style="' + style + '" title="' + escapeAttr(field.name) + '" placeholder="' + escapeAttr(field.name) + '">' + escapeText(field.value) + "</textarea>";
      }

      return '<input class="field-overlay text" type="text" data-overlay-field="' + escapeAttr(field.name) + '" style="' + style + '" value="' + escapeAttr(field.value) + '" title="' + escapeAttr(field.name) + '" placeholder="' + escapeAttr(field.name) + '">';
    }).join("");
  }

  function renderMarksHtml() {
    var visible = state.marks.filter(function (mark) {
      return mark.pageIndex === state.currentPage;
    });
    return visible.map(renderMark).join("");
  }

  function renderMark(mark) {
    autoSizeTextMark(mark);
    var style = [
      "left:" + (mark.x * 100) + "%",
      "top:" + (mark.y * 100) + "%",
      "width:" + (mark.width * 100) + "%",
      "height:" + (mark.height * 100) + "%",
      "font-size:" + mark.size + "px",
      "color:" + escapeAttr(mark.color)
    ].join(";");
    var selected = mark.id === state.selectedMarkId ? " selected" : "";
    var dragButton = '<button class="mark-drag" type="button" data-drag-mark="' + escapeAttr(mark.id) + '" aria-label="Move mark"></button>';
    var deleteButton = '<button class="mark-delete" type="button" data-delete-mark="' + escapeAttr(mark.id) + '" aria-label="Delete mark">x</button>';
    var resizeHandle = '<span class="mark-resize" data-resize-mark="' + escapeAttr(mark.id) + '" aria-label="Resize mark" role="button" tabindex="-1"></span>';
    var content = "";

    if (isImageMark(mark)) {
      content = '<img alt="" src="' + escapeAttr(mark.dataUrl) + '">';
    } else if (mark.type === "check") {
      content = "✓";
    } else {
      content = '<span class="mark-content" contenteditable="true" spellcheck="false" data-editable-mark="' + escapeAttr(mark.id) + '" data-empty="' + String(!mark.text) + '" data-placeholder="' + escapeAttr(mark.type === "initials" ? "Initials" : "Type here") + '">' + escapeText(mark.text) + "</span>";
    }

    return '<div class="mark ' + escapeAttr(mark.type) + selected + '" data-mark-id="' + escapeAttr(mark.id) + '" style="' + style + '">' + dragButton + content + deleteButton + resizeHandle + "</div>";
  }

  function handleStageClick(event) {
    if (!state.pdfjsDoc || event.target.closest(".mark")) {
      return;
    }
    if (event.target.closest(".field-overlay")) {
      deselectSelectedMark();
      return;
    }
    if (!state.activeTool) {
      deselectSelectedMark();
      return;
    }
    var rect = $("#overlayLayer").getBoundingClientRect();
    var x = (event.clientX - rect.left) / Math.max(1, rect.width);
    var y = (event.clientY - rect.top) / Math.max(1, rect.height);
    addMarkAt(x, y);
  }

  function addMarkAt(x, y) {
    var mark = buildMark(x, y);
    if (!mark) {
      return;
    }
    state.marks.push(mark);
    state.selectedMarkId = mark.id;
    renderOverlayFromCurrent();
    renderSelectedControls();
    focusEditableMark(mark.id);
    updateStats();
    setTool("");
    setStatus("Mark placed; no tool selected");
  }

  function buildMark(x, y) {
    var tool = state.activeTool;
    var size = clampNumber($("#markSize").value, 8, 96, 16);
    var color = $("#markColor").value;
    var mark = {
      id: "mark-" + state.markCounter,
      pageIndex: state.currentPage,
      type: tool,
      x: clampNumber(x, 0, 0.96, 0.1),
      y: clampNumber(y, 0, 0.96, 0.1),
      width: 0.24,
      height: 0.045,
      size: size,
      color: color,
      text: ""
    };
    state.markCounter += 1;

    if (tool === "text") {
      mark.text = "";
      mark.width = 0.1;
      mark.autoSize = true;
    } else if (tool === "date") {
      mark.text = $("#markDate").value || new Date().toISOString().slice(0, 10);
      mark.width = 0.22;
      mark.autoSize = true;
    } else if (tool === "initials") {
      if (!state.savedInitialsDataUrl) {
        openInkDialog("initials");
        return null;
      }
      mark.dataUrl = state.savedInitialsDataUrl;
      mark.width = clampNumber($("#signatureScale").value, 8, 95, 34) / 260;
      mark.height = mark.width * state.savedInitialsAspect;
    } else if (tool === "check") {
      mark.width = 0.045;
      mark.height = 0.045;
      mark.size = Math.max(18, size);
    } else if (tool === "signature") {
      if (!state.savedSignatureDataUrl) {
        openInkDialog("signature");
        return null;
      }
      mark.dataUrl = state.savedSignatureDataUrl;
      mark.width = clampNumber($("#signatureScale").value, 8, 95, 34) / 100;
      mark.height = mark.width * state.savedSignatureAspect;
    }
    autoSizeTextMark(mark);
    return mark;
  }

  function handleMarkPointerDown(event) {
    if (event.target.closest(".mark-delete")) {
      return;
    }
    var element = event.target.closest(".mark");
    if (!element) {
      return;
    }
    var mark = getMark(element.dataset.markId);
    if (!mark) {
      return;
    }
    state.selectedMarkId = mark.id;
    if (event.target.closest(".mark-drag")) {
      event.preventDefault();
      startMarkDrag(event, mark, element);
      updateSelectedMarkClass();
      renderSelectedControls();
      return;
    }
    if (event.target.closest(".mark-resize")) {
      event.preventDefault();
      startMarkResize(event, mark, element);
      updateSelectedMarkClass();
      renderSelectedControls();
      return;
    }
    if (event.target.closest("[data-editable-mark]")) {
      updateSelectedMarkClass();
      renderSelectedControls();
      return;
    }
    event.preventDefault();
    startMarkDrag(event, mark, element);
    updateSelectedMarkClass();
    renderSelectedControls();
  }

  function startMarkDrag(event, mark, element) {
    var rect = $("#overlayLayer").getBoundingClientRect();
    state.dragging = {
      markId: mark.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: mark.x,
      originY: mark.y,
      width: rect.width,
      height: rect.height
    };
    try {
      element.setPointerCapture(event.pointerId);
    } catch (error) {
      // Dragging still works through the window-level pointer handlers.
    }
  }

  function handleMarkPointerMove(event) {
    if (state.resizing) {
      resizeSelectedMark(event);
      return;
    }
    if (!state.dragging) {
      return;
    }
    var mark = getMark(state.dragging.markId);
    if (!mark) {
      return;
    }
    mark.x = clampNumber(state.dragging.originX + (event.clientX - state.dragging.startX) / Math.max(1, state.dragging.width), 0, 1 - mark.width, mark.x);
    mark.y = clampNumber(state.dragging.originY + (event.clientY - state.dragging.startY) / Math.max(1, state.dragging.height), 0, 1 - mark.height, mark.y);
    updateMarkElementPosition(mark);
  }

  function startMarkResize(event, mark, element) {
    var rect = $("#overlayLayer").getBoundingClientRect();
    state.resizing = {
      markId: mark.id,
      startX: event.clientX,
      startY: event.clientY,
      originWidth: mark.width,
      originHeight: mark.height,
      originSize: mark.size,
      width: rect.width,
      height: rect.height
    };
    try {
      element.setPointerCapture(event.pointerId);
    } catch (error) {
      // Window-level pointer handlers continue resizing if capture is unavailable.
    }
  }

  function resizeSelectedMark(event) {
    var mark = getMark(state.resizing.markId);
    if (!mark) {
      return;
    }
    var layerWidth = Math.max(1, state.resizing.width);
    var layerHeight = Math.max(1, state.resizing.height);
    var originWidthPx = Math.max(1, state.resizing.originWidth * layerWidth);
    var originHeightPx = Math.max(1, state.resizing.originHeight * layerHeight);
    var widthPx = originWidthPx + event.clientX - state.resizing.startX;
    var heightPx = originHeightPx + event.clientY - state.resizing.startY;
    var minWidthPx = mark.type === "check" ? 14 : 24;
    var minHeightPx = mark.type === "check" ? 14 : 16;
    var maxWidthPx = Math.max(minWidthPx, (1 - mark.x) * layerWidth);
    var maxHeightPx = Math.max(minHeightPx, (1 - mark.y) * layerHeight);

    if (isTextMark(mark)) {
      var textScale = Math.max(widthPx / originWidthPx, heightPx / originHeightPx);
      mark.size = clampNumber(state.resizing.originSize * textScale, 8, 96, state.resizing.originSize);
      mark.autoSize = true;
      autoSizeTextMark(mark);
      updateMarkElementLayout(mark);
      syncToolbarValues();
      return;
    }

    if (isImageMark(mark) || mark.type === "check") {
      var scale = Math.max(widthPx / originWidthPx, heightPx / originHeightPx);
      var maxScale = Math.min(maxWidthPx / originWidthPx, maxHeightPx / originHeightPx);
      var minScale = Math.max(minWidthPx / originWidthPx, minHeightPx / originHeightPx);
      scale = clampNumber(scale, minScale, Math.max(minScale, maxScale), 1);
      widthPx = originWidthPx * scale;
      heightPx = originHeightPx * scale;
    } else {
      widthPx = clampNumber(widthPx, minWidthPx, maxWidthPx, originWidthPx);
      heightPx = clampNumber(heightPx, minHeightPx, maxHeightPx, originHeightPx);
      mark.autoSize = false;
    }

    mark.width = widthPx / layerWidth;
    mark.height = heightPx / layerHeight;
    if (mark.type === "check") {
      mark.size = Math.max(12, Math.min(widthPx, heightPx) * 0.9);
    }
    updateMarkElementLayout(mark);
    syncToolbarValues();
  }

  function handleMarkPointerUp() {
    state.dragging = null;
    if (state.resizing) {
      state.resizing = null;
      renderSelectedControls();
    }
  }

  function handleFormInput(event) {
    var selected = getSelectedMark();
    if (event.target.id === "selectedText" && selected) {
      selected.text = event.target.value;
      autoSizeTextMark(selected);
      renderOverlayFromCurrent();
    } else if (event.target.id === "selectedColor" && selected) {
      selected.color = event.target.value;
      renderOverlayFromCurrent();
    } else if (event.target.id === "selectedSize" && selected) {
      applySizeToMark(selected, clampNumber(event.target.value, 8, 96, selected.size));
      $("#selectedSizeValue").textContent = selected.size + " pt";
      renderOverlayFromCurrent();
    } else if (event.target.id === "selectedPage" && selected) {
      selected.pageIndex = Number(event.target.value);
      state.currentPage = selected.pageIndex;
      renderCurrentPage();
    }
    syncControls();
  }

  function handleToolbarInput(event) {
    syncToolbarValueLabels();
    var selected = getSelectedMark();
    if (!selected) {
      return;
    }

    if (event.target.id === "markSize" && (isTextMark(selected) || selected.type === "check")) {
      applySizeToMark(selected, clampNumber(event.target.value, 8, 96, selected.size || 16));
      renderSelectedControls();
    } else if (event.target.id === "signatureScale" && isImageMark(selected)) {
      applyImageWidthToMark(selected, clampNumber(event.target.value, 8, 95, selected.width * 100));
      renderSelectedControls();
    } else if (event.target.id === "markColor" && !isImageMark(selected)) {
      selected.color = event.target.value;
      updateMarkElementLayout(selected);
      renderSelectedControls();
    }
    syncToolbarValues();
  }

  function applySizeToMark(mark, size) {
    mark.size = clampNumber(size, 8, 96, mark.size || 16);
    if (isTextMark(mark)) {
      mark.autoSize = true;
      autoSizeTextMark(mark);
    } else if (mark.type === "check" && state.currentViewport) {
      var checkSize = Math.max(14, mark.size * 1.12);
      mark.width = Math.min(1 - mark.x, checkSize / Math.max(1, state.currentViewport.width));
      mark.height = Math.min(1 - mark.y, checkSize / Math.max(1, state.currentViewport.height));
    }
    updateMarkElementLayout(mark);
  }

  function applyImageWidthToMark(mark, percent) {
    if (!state.currentViewport) {
      return;
    }
    var aspect = mark.height / Math.max(0.001, mark.width);
    var width = clampNumber(percent, 8, 95, mark.width * 100) / 100;
    width = Math.min(width, Math.max(0.02, 1 - mark.x));
    if (mark.y + width * aspect > 1) {
      width = Math.max(0.02, (1 - mark.y) / Math.max(0.001, aspect));
    }
    mark.width = width;
    mark.height = mark.width * aspect;
    updateMarkElementLayout(mark);
  }

  function renderSelectedControls() {
    var mark = getSelectedMark();
    $("#selectedEmpty").hidden = Boolean(mark);
    $("#selectedControls").hidden = !mark;
    if (!mark) {
      syncToolbarValues();
      return;
    }

    $("#selectedText").disabled = isImageMark(mark) || mark.type === "check";
    $("#selectedText").value = mark.type === "check" ? "✓" : mark.text || "";
    $("#selectedColor").value = mark.color || "#111827";
    $("#selectedColor").disabled = isImageMark(mark);
    $("#selectedSize").disabled = isImageMark(mark);
    $("#selectedSize").value = mark.size;
    $("#selectedSizeValue").textContent = mark.size + " pt";
    $("#selectedPage").innerHTML = Array.from({ length: state.pageCount }, function (_, index) {
      return '<option value="' + index + '"' + (index === mark.pageIndex ? " selected" : "") + ">Page " + (index + 1) + "</option>";
    }).join("");
    syncToolbarValues();
  }

  function deleteSelectedMark() {
    if (!state.selectedMarkId) {
      return;
    }
    state.marks = state.marks.filter(function (mark) {
      return mark.id !== state.selectedMarkId;
    });
    state.selectedMarkId = "";
    renderOverlayFromCurrent();
    renderSelectedControls();
    updateStats();
  }

  function handleOverlayClick(event) {
    var deleteButton = event.target.closest("[data-delete-mark]");
    if (deleteButton) {
      event.preventDefault();
      state.selectedMarkId = deleteButton.dataset.deleteMark;
      deleteSelectedMark();
    }
  }

  function handleOverlayInput(event) {
    var fieldInput = event.target.closest("[data-overlay-field]");
    if (fieldInput) {
      var field = getFieldByName(fieldInput.dataset.overlayField);
      if (!field) {
        return;
      }
      if (field.type === "checkbox") {
        field.checked = fieldInput.checked;
      } else if (field.type === "radio") {
        if (!fieldInput.checked) {
          return;
        }
        field.value = fieldInput.dataset.overlayValue || fieldInput.value;
      } else {
        field.value = fieldInput.value;
      }
      updateFieldListInput(field);
      updateOverlayFieldInput(field, fieldInput);
      updateStats();
      return;
    }

    var editable = event.target.closest("[data-editable-mark]");
    if (!editable) {
      return;
    }
    var mark = getMark(editable.dataset.editableMark);
    if (!mark) {
      return;
    }
    mark.text = editable.textContent || "";
    editable.dataset.empty = String(!mark.text);
    autoSizeTextMark(mark);
    updateMarkElementLayout(mark);
    if (mark.id === state.selectedMarkId) {
      renderSelectedControls();
    }
    updateStats();
  }

  function deselectSelectedMark() {
    if (!state.selectedMarkId) {
      return;
    }
    state.selectedMarkId = "";
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
    updateSelectedMarkClass();
    renderSelectedControls();
  }

  function handleKeydown(event) {
    if (event.key === "Escape" && !$("#inkDialog").hidden) {
      event.preventDefault();
      closeInkDialog();
      return;
    }

    if ((event.key !== "Backspace" && event.key !== "Delete") || !state.selectedMarkId) {
      return;
    }
    var active = document.activeElement;
    if (active && (active.matches("input, textarea, select") || active.isContentEditable)) {
      return;
    }
    event.preventDefault();
    deleteSelectedMark();
  }

  function updateSelectedMarkClass() {
    $$("[data-mark-id]").forEach(function (element) {
      element.classList.toggle("selected", element.dataset.markId === state.selectedMarkId);
    });
  }

  function updateMarkElementPosition(mark) {
    var element = getMarkElement(mark.id);
    if (!element) {
      return;
    }
    element.style.left = (mark.x * 100) + "%";
    element.style.top = (mark.y * 100) + "%";
  }

  function updateMarkElementLayout(mark) {
    var element = getMarkElement(mark.id);
    if (!element) {
      return;
    }
    element.style.left = (mark.x * 100) + "%";
    element.style.top = (mark.y * 100) + "%";
    element.style.width = (mark.width * 100) + "%";
    element.style.height = (mark.height * 100) + "%";
    element.style.fontSize = mark.size + "px";
    element.style.color = mark.color || "#111827";
  }

  function autoSizeTextMark(mark) {
    if (!isTextMark(mark) || mark.autoSize === false || !state.currentViewport || mark.pageIndex !== state.currentPage) {
      return;
    }

    var layerWidth = Math.max(1, state.currentViewport.width);
    var layerHeight = Math.max(1, state.currentViewport.height);
    var maxWidth = Math.max(24, (1 - mark.x) * layerWidth - 4);
    var maxHeight = Math.max(18, (1 - mark.y) * layerHeight - 4);
    var box = measureTextMark(mark, maxWidth);

    mark.width = clampNumber(box.width / layerWidth, 0.035, Math.max(0.035, 1 - mark.x), mark.width);
    mark.height = clampNumber(box.height / layerHeight, 0.024, Math.max(0.024, 1 - mark.y), mark.height);

    if (box.height > maxHeight) {
      mark.height = maxHeight / layerHeight;
    }
  }

  function isTextMark(mark) {
    return mark && !isImageMark(mark) && (mark.type === "text" || mark.type === "date" || mark.type === "initials");
  }

  function isImageMark(mark) {
    return mark && (mark.type === "signature" || Boolean(mark.dataUrl));
  }

  function measureTextMark(mark, maxWidth) {
    var measurer = getTextMarkMeasurer();
    var content = measurer.querySelector(".mark-content");
    measurer.className = "mark " + mark.type;
    measurer.style.maxWidth = maxWidth + "px";
    measurer.style.fontSize = mark.size + "px";
    measurer.style.color = mark.color || "#111827";
    content.textContent = mark.text || "";
    content.dataset.empty = String(!mark.text);
    content.dataset.placeholder = getTextMarkPlaceholder(mark);

    var rect = measurer.getBoundingClientRect();
    return {
      width: Math.min(maxWidth, Math.ceil(rect.width) + 2),
      height: Math.ceil(rect.height) + 2
    };
  }

  function getTextMarkMeasurer() {
    if (textMarkMeasurer) {
      return textMarkMeasurer;
    }
    textMarkMeasurer = document.createElement("div");
    textMarkMeasurer.className = "mark text";
    textMarkMeasurer.setAttribute("aria-hidden", "true");
    textMarkMeasurer.style.position = "fixed";
    textMarkMeasurer.style.left = "-10000px";
    textMarkMeasurer.style.top = "-10000px";
    textMarkMeasurer.style.display = "inline-block";
    textMarkMeasurer.style.width = "auto";
    textMarkMeasurer.style.height = "auto";
    textMarkMeasurer.style.visibility = "hidden";
    textMarkMeasurer.style.pointerEvents = "none";
    textMarkMeasurer.innerHTML = '<span class="mark-content"></span>';
    document.body.appendChild(textMarkMeasurer);
    return textMarkMeasurer;
  }

  function getTextMarkPlaceholder(mark) {
    return mark && mark.type === "initials" ? "Initials" : "Type here";
  }

  function focusEditableMark(id) {
    window.requestAnimationFrame(function () {
      var mark = getMark(id);
      if (!mark || isImageMark(mark) || mark.type === "check") {
        return;
      }
      var editable = getEditableMarkElement(id);
      if (!editable) {
        return;
      }
      editable.focus();
      placeCaretAtEnd(editable);
    });
  }

  function getMarkElement(id) {
    return $$(".mark").find(function (element) {
      return element.dataset.markId === id;
    });
  }

  function getEditableMarkElement(id) {
    return $$("[data-editable-mark]").find(function (element) {
      return element.dataset.editableMark === id;
    });
  }

  function placeCaretAtEnd(element) {
    var selection = window.getSelection();
    if (!selection || !document.createRange) {
      return;
    }
    var range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function handleToolButtonClick(tool) {
    if (!state.bytes) {
      setStatus("Choose a PDF first", "warn");
      return;
    }
    if (state.activeTool === tool) {
      setTool("");
      return;
    }
    if (tool === "signature" && !state.savedSignatureDataUrl) {
      openInkDialog("signature");
      return;
    }
    if (tool === "initials" && !state.savedInitialsDataUrl) {
      openInkDialog("initials");
      return;
    }
    setTool(tool);
  }

  function setTool(tool) {
    state.activeTool = tool || "";
    $$(".tool-card").forEach(function (button) {
      var active = button.dataset.tool === state.activeTool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    updateToolMode();
    syncSignatureControls();
    return true;
  }

  function updateToolMode() {
    var modes = {
      idle: {
        title: "No tool selected",
        detail: "Choose a tool above, then click once on the PDF page."
      },
      text: {
        title: "Text box armed",
        detail: "Click once on the page to add an editable text box."
      },
      check: {
        title: "Checkmark armed",
        detail: "Click once on the page to place a checkmark."
      },
      date: {
        title: "Date armed",
        detail: "Click once on the page to place the selected date."
      },
      initials: {
        title: "Initials armed",
        detail: "Click once on the page to place your saved initials."
      },
      signature: {
        title: "Signature armed",
        detail: "Click once on the page to place your saved signature."
      }
    };
    var activeTool = state.activeTool || "idle";
    var mode = modes[activeTool] || modes.idle;
    $("#toolModeTitle").textContent = mode.title;
    $("#toolModeDetail").textContent = mode.detail;
    $("#toolMode").dataset.tool = activeTool;
    $("#pageCanvasWrap").dataset.activeTool = activeTool;
  }

  function syncSignatureControls() {
    var hasPdf = Boolean(state.bytes) && !state.busy;
    $$(".tool-card").forEach(function (button) {
      button.disabled = !hasPdf;
    });
    syncInkControls();
  }

  function setPage(pageIndex) {
    if (!state.pdfjsDoc) {
      return;
    }
    state.currentPage = Math.min(state.pageCount - 1, Math.max(0, pageIndex));
    renderCurrentPage();
    syncControls();
  }

  async function downloadFilledPdf() {
    if (!state.bytes) {
      setStatus("Choose a PDF first", "warn");
      return;
    }

    setBusy(true, "Building filled PDF");
    try {
      var flattening = $("#flattenFields").checked;
      var bytes = await buildFilledPdf();
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), getOutputName());
      setBusy(false, formatBytes(bytes.length) + (flattening ? " flattened PDF ready" : " PDF ready; fields editable"));
    } catch (error) {
      setBusy(false, getErrorMessage(error), "danger");
    }
  }

  async function buildFilledPdf() {
    var PDFLib = window.PDFLib;
    var doc = await PDFLib.PDFDocument.load(state.bytes, {
      ignoreEncryption: true,
      updateMetadata: false
    });
    applyFormValues(doc);

    if ($("#flattenFields").checked) {
      try {
        doc.getForm().flatten();
      } catch (error) {
        // PDFs without AcroForm fields do not need flattening.
      }
    }

    var regular = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    var bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    var signatureImages = {};

    for (var index = 0; index < state.marks.length; index += 1) {
      var mark = state.marks[index];
      var page = doc.getPages()[mark.pageIndex];
      if (!page) {
        continue;
      }
      if (isImageMark(mark)) {
        if (!signatureImages[mark.id]) {
          signatureImages[mark.id] = await doc.embedPng(dataUrlToBytes(mark.dataUrl));
        }
        drawSignatureMark(page, mark, signatureImages[mark.id]);
      } else if (mark.type === "check") {
        drawCheckMark(page, mark);
      } else {
        drawTextMark(page, mark, mark.type === "initials" ? bold : regular);
      }
    }

    doc.setCreator("Fill Freely");
    doc.setProducer("Fill Freely");
    doc.setModificationDate(new Date());
    return await doc.save({
      useObjectStreams: true,
      updateFieldAppearances: true
    });
  }

  function applyFormValues(doc) {
    var form;
    try {
      form = doc.getForm();
    } catch (error) {
      return;
    }

    state.formFields.forEach(function (field) {
      try {
        if (field.type === "text") {
          form.getTextField(field.name).setText(field.value || "");
        } else if (field.type === "checkbox") {
          var checkbox = form.getCheckBox(field.name);
          if (field.checked) {
            checkbox.check();
          } else {
            checkbox.uncheck();
          }
        } else if (field.type === "dropdown") {
          form.getDropdown(field.name).select(field.value || "");
        } else if (field.type === "radio") {
          form.getRadioGroup(field.name).select(field.value || "");
        } else if (field.type === "optionlist") {
          form.getOptionList(field.name).select(field.value || "");
        }
      } catch (error) {
        // Leave unsupported or malformed fields unchanged.
      }
    });
  }

  function drawTextMark(page, mark, font) {
    var size = page.getSize();
    var fontSize = mark.size;
    var x = mark.x * size.width;
    var y = size.height - mark.y * size.height - fontSize;
    var maxWidth = getTextMarkPdfWidth(mark, font, fontSize, size.width);
    var lines = wrapText(mark.text || "", font, fontSize, maxWidth);
    lines.forEach(function (line, index) {
      page.drawText(line, {
        x: x,
        y: y - index * fontSize * 1.22,
        size: fontSize,
        font: font,
        color: hexToRgb(mark.color)
      });
    });
  }

  function getTextMarkPdfWidth(mark, font, fontSize, pageWidth) {
    var remainingWidth = Math.max(12, pageWidth - mark.x * pageWidth - 2);
    var text = mark.text || "";
    var widestLine = text.split(/\r?\n/).reduce(function (widest, line) {
      return Math.max(widest, font.widthOfTextAtSize(line || "", fontSize));
    }, 0);
    return Math.min(remainingWidth, Math.max(12, widestLine + fontSize * 0.5));
  }

  function drawCheckMark(page, mark) {
    var size = page.getSize();
    var x = mark.x * size.width;
    var y = size.height - mark.y * size.height - mark.height * size.height;
    var width = Math.max(10, mark.width * size.width);
    var height = Math.max(10, mark.height * size.height);
    var color = hexToRgb(mark.color);
    page.drawLine({
      start: { x: x + width * 0.08, y: y + height * 0.45 },
      end: { x: x + width * 0.38, y: y + height * 0.12 },
      thickness: Math.max(2, width * 0.12),
      color: color
    });
    page.drawLine({
      start: { x: x + width * 0.38, y: y + height * 0.12 },
      end: { x: x + width * 0.94, y: y + height * 0.9 },
      thickness: Math.max(2, width * 0.12),
      color: color
    });
  }

  function drawSignatureMark(page, mark, image) {
    var size = page.getSize();
    var width = mark.width * size.width;
    var height = mark.height * size.height;
    page.drawImage(image, {
      x: mark.x * size.width,
      y: size.height - mark.y * size.height - height,
      width: width,
      height: height
    });
  }

  function wrapText(text, font, fontSize, maxWidth) {
    var words = String(text || "").split(/\s+/);
    var lines = [];
    var line = "";
    words.forEach(function (word) {
      var candidate = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    });
    if (line) {
      lines.push(line);
    }
    return lines.length ? lines : [""];
  }

  function initSignaturePad() {
    var canvas = $("#signaturePad");
    var context = canvas.getContext("2d");
    var drawing = false;
    var lastPoint = null;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 5;
    context.strokeStyle = "#111827";

    canvas.addEventListener("pointerdown", function (event) {
      drawing = true;
      lastPoint = getCanvasPoint(canvas, event);
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        // Some synthetic or older pointer paths cannot be captured.
      }
    });
    canvas.addEventListener("pointermove", function (event) {
      if (!drawing || !lastPoint) {
        return;
      }
      var point = getCanvasPoint(canvas, event);
      context.beginPath();
      context.moveTo(lastPoint.x, lastPoint.y);
      context.lineTo(point.x, point.y);
      context.stroke();
      lastPoint = point;
      if (!state.signatureDirty) {
        state.signatureDirty = true;
        syncInkControls();
      }
    });
    canvas.addEventListener("pointerup", function () {
      drawing = false;
      lastPoint = null;
    });
    canvas.addEventListener("pointercancel", function () {
      drawing = false;
      lastPoint = null;
    });
    $("#clearSignature").addEventListener("click", function () {
      clearInkPad();
    });
    $("#useSignature").addEventListener("click", function () {
      saveInkMark();
    });
    $("#cancelInk").addEventListener("click", function () {
      closeInkDialog();
    });
    $("#typedInkText").addEventListener("input", syncInkControls);
  }

  function openInkDialog(tool) {
    state.inkTool = tool;
    clearInkPad();
    $("#typedInkText").placeholder = tool === "initials" ? "Type initials" : "Type a signature";
    $("#inkEyebrow").textContent = tool === "initials" ? "Saved initials" : "Saved signature";
    $("#inkTitle").textContent = tool === "initials" ? "Create initials" : "Create signature";
    $("#inkNote").textContent = tool === "initials"
      ? "Draw your initials or type them to generate a reusable initials mark."
      : "Draw your signature or type your name to generate a reusable visual signature. This is not a cryptographic digital signature.";
    $("#useSignature").textContent = tool === "initials" ? "Save initials and place" : "Save signature and place";
    $("#inkDialog").hidden = false;
    window.requestAnimationFrame(function () {
      $("#signaturePad").focus();
    });
  }

  function closeInkDialog() {
    $("#inkDialog").hidden = true;
    state.inkTool = "";
    clearInkPad();
  }

  function clearInkPad() {
    var canvas = $("#signaturePad");
    var context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    state.signatureDirty = false;
    $("#typedInkText").value = "";
    syncInkControls();
  }

  function syncInkControls() {
    var button = $("#useSignature");
    if (!button) {
      return;
    }
    button.disabled = !state.signatureDirty && !$("#typedInkText").value.trim();
  }

  function saveInkMark() {
    var tool = state.inkTool || "signature";
    var typed = $("#typedInkText").value.trim();
    if (!state.signatureDirty && !typed) {
      setStatus("Draw or type first", "warn");
      syncInkControls();
      return;
    }
    var ink = state.signatureDirty ? trimCanvasToInk($("#signaturePad"), 8) : generateInkData(typed, tool);
    if (tool === "initials") {
      state.savedInitialsDataUrl = ink.dataUrl;
      state.savedInitialsAspect = ink.aspect;
    } else {
      state.savedSignatureDataUrl = ink.dataUrl;
      state.savedSignatureAspect = ink.aspect;
    }
    closeInkDialog();
    setTool(tool);
  }

  function generateInkData(text, tool) {
    var canvas = document.createElement("canvas");
    canvas.width = tool === "initials" ? 420 : 720;
    canvas.height = 220;
    var context = canvas.getContext("2d");
    var fontSize = tool === "initials" ? 98 : 86;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111827";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = fontSize + 'px "Snell Roundhand", "Segoe Script", "Brush Script MT", cursive';
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 8, canvas.width - 20);
    return trimCanvasToInk(canvas, 8);
  }

  function trimCanvasToInk(canvas, padding) {
    var context = canvas.getContext("2d");
    var width = canvas.width;
    var height = canvas.height;
    var pixels = context.getImageData(0, 0, width, height).data;
    var left = width;
    var right = 0;
    var top = height;
    var bottom = 0;
    var found = false;

    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        if (pixels[(y * width + x) * 4 + 3] > 12) {
          found = true;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }

    if (!found) {
      return {
        dataUrl: canvas.toDataURL("image/png"),
        aspect: canvas.height / Math.max(1, canvas.width)
      };
    }

    padding = Math.max(0, Number(padding) || 0);
    left = Math.max(0, left - padding);
    top = Math.max(0, top - padding);
    right = Math.min(width - 1, right + padding);
    bottom = Math.min(height - 1, bottom + padding);

    var trimmed = document.createElement("canvas");
    trimmed.width = Math.max(1, right - left + 1);
    trimmed.height = Math.max(1, bottom - top + 1);
    trimmed.getContext("2d").drawImage(canvas, left, top, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
    return {
      dataUrl: trimmed.toDataURL("image/png"),
      aspect: trimmed.height / Math.max(1, trimmed.width)
    };
  }

  function syncControls() {
    syncToolbarValues();

    var hasPdf = Boolean(state.bytes) && !state.busy;
    $("#downloadPdf").disabled = !hasPdf;
    $("#prevPage").disabled = !hasPdf || state.currentPage <= 0;
    $("#nextPage").disabled = !hasPdf || state.currentPage >= state.pageCount - 1;
    syncSignatureControls();
    updateStats();
  }

  function syncToolbarValues() {
    var selected = getSelectedMark();
    if (selected && (isTextMark(selected) || selected.type === "check")) {
      $("#markSize").value = Math.round(clampNumber(selected.size, 8, 96, 16));
    } else {
      $("#markSize").value = Math.round(clampNumber($("#markSize").value, 8, 96, 16));
    }

    if (selected && isImageMark(selected)) {
      $("#signatureScale").value = Math.round(clampNumber(selected.width * 100, 8, 95, 34));
    } else {
      $("#signatureScale").value = Math.round(clampNumber($("#signatureScale").value, 8, 95, 34));
    }

    if (selected && selected.color && !isImageMark(selected)) {
      $("#markColor").value = selected.color;
    }
    syncToolbarValueLabels();
  }

  function syncToolbarValueLabels() {
    $("#markSizeValue").textContent = Math.round(clampNumber($("#markSize").value, 8, 96, 16)) + " pt";
    $("#signatureScaleValue").textContent = Math.round(clampNumber($("#signatureScale").value, 8, 95, 34)) + "%";
  }

  function updateStats() {
    $("#fileName").textContent = state.file ? state.file.name : "None";
    $("#pageCount").textContent = state.pageCount;
    $("#fieldCount").textContent = state.formFields.length;
    $("#markCount").textContent = state.marks.length;
  }

  function toggleDetails() {
    var form = $("#fillForm");
    var button = $("#toggleDetails");
    var open = form.hidden;
    form.hidden = !open;
    form.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Hide details" : "Details";
  }

  function resetAll() {
    resetDocument(true);
    $("#fillForm").reset();
    $("#outputName").value = "fillfreely-filled.pdf";
    $("#markColor").value = "#111827";
    $("#markSize").value = "16";
    $("#signatureScale").value = "34";
    setDefaultDate();
    setTool("");
    setStatus("Ready");
    syncControls();
  }

  function resetDocument(clearFileInput) {
    if (state.pdfjsDoc && state.pdfjsDoc.destroy) {
      state.pdfjsDoc.destroy();
    }
    state.file = null;
    state.bytes = null;
    state.pdfDoc = null;
    state.pdfjsDoc = null;
    state.pageCount = 0;
    state.currentPage = 0;
    state.currentAnnotations = [];
    state.currentViewport = null;
    state.pageSizes = [];
    state.formFields = [];
    state.marks = [];
    state.activeTool = "";
    state.selectedMarkId = "";
    state.markCounter = 1;
    state.dragging = null;
    state.resizing = null;
    $("#pageRail").innerHTML = "";
    $("#overlayLayer").innerHTML = "";
    $("#fieldList").innerHTML = '<div class="subtle-box">Upload a PDF to detect fillable fields.</div>';
    $("#emptyState").hidden = false;
    $("#pageStage").hidden = true;
    renderSelectedControls();
    setTool("");
    if (clearFileInput) {
      $("#fileInput").value = "";
    }
  }

  function setDefaultDate() {
    $("#markDate").value = new Date().toISOString().slice(0, 10);
  }

  function setBusy(isBusy, text, level) {
    state.busy = isBusy;
    setStatus(text, level);
    syncControls();
  }

  function setStatus(text, level) {
    var badge = $("#engineBadge");
    badge.textContent = text || "Ready";
    badge.classList.toggle("warn", level === "warn");
    badge.classList.toggle("danger", level === "danger");
  }

  function getMark(id) {
    return state.marks.find(function (mark) {
      return mark.id === id;
    });
  }

  function getSelectedMark() {
    return getMark(state.selectedMarkId);
  }

  function getCanvasPoint(canvas, event) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height))
    };
  }

  function dataUrlToBytes(dataUrl) {
    var base64 = dataUrl.split(",")[1] || "";
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function hexToRgb(hex) {
    var value = String(hex || "#111827").replace("#", "");
    if (value.length === 3) {
      value = value.split("").map(function (char) {
        return char + char;
      }).join("");
    }
    var number = parseInt(value, 16);
    return window.PDFLib.rgb(((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255);
  }

  function clampNumber(value, min, max, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) {
      number = fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function debounce(fn, delay) {
    var timer = 0;
    return function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(fn, delay);
    };
  }

  function makeOutputName(name) {
    return String(name || "document.pdf").replace(/\.pdf$/i, "") + "-filled.pdf";
  }

  function getOutputName() {
    var raw = $("#outputName").value.trim() || "fillfreely-filled.pdf";
    return /\.pdf$/i.test(raw) ? raw : raw + ".pdf";
  }

  function formatBytes(bytes) {
    if (!bytes) {
      return "0 KB";
    }
    var units = ["B", "KB", "MB", "GB"];
    var value = bytes;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return (unit === 0 ? value : value.toFixed(value >= 10 ? 1 : 2)) + " " + units[unit];
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 500);
  }

  function getErrorMessage(error) {
    var message = error && error.message ? error.message : String(error || "");
    if (/encrypted|password/i.test(message)) {
      return "Encrypted PDFs need a password before they can be filled.";
    }
    return message || "Unable to process this PDF.";
  }

  function escapeAttr(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeText(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
})();
