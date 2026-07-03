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
    busy: false,
    encrypted: false,
    renderTask: null,
    renderGeneration: 0,
    loadToken: 0,
    detailsAutoOpened: false,
    inkReturnFocus: null,
    imageWidthDefaults: { signature: 34, initials: 12 }
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
      event.stopPropagation();
      $("#dropZone").classList.remove("dragging");
      var file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) {
        loadPdf(file);
      }
    });

    window.addEventListener("dragover", function (event) {
      event.preventDefault();
    });
    window.addEventListener("drop", function (event) {
      event.preventDefault();
      $("#dropZone").classList.remove("dragging");
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
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
    $("#markDate").addEventListener("input", handleToolbarInput);
    $("#markDate").addEventListener("change", handleToolbarInput);
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
        renderCurrentPage().catch(reportRenderError);
      }
    }, 150));
  }

  function reportRenderError(error) {
    setStatus(getErrorMessage(error), "danger");
  }

  async function loadPdf(file) {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setStatus("Use a PDF file", "warn");
      return;
    }

    state.loadToken += 1;
    var token = state.loadToken;
    setBusy(true, "Reading PDF");
    resetDocument(false);

    try {
      var buffer = await file.arrayBuffer();
      if (token !== state.loadToken) {
        return;
      }
      state.file = file;
      state.bytes = new Uint8Array(buffer);
      var pdfDoc = await window.PDFLib.PDFDocument.load(state.bytes, {
        ignoreEncryption: true,
        updateMetadata: false
      });
      if (token !== state.loadToken) {
        return;
      }
      state.pdfDoc = pdfDoc;
      state.encrypted = Boolean(pdfDoc.isEncrypted);
      var pdfjsDoc = await window.pdfjsLib.getDocument({
        data: state.bytes.slice(0),
        disableFontFace: true
      }).promise;
      if (token !== state.loadToken) {
        pdfjsDoc.destroy();
        return;
      }
      state.pdfjsDoc = pdfjsDoc;
      state.pageCount = pdfDoc.getPageCount();
      state.pageSizes = [];
      for (var pageIndex = 0; pageIndex < pdfjsDoc.numPages; pageIndex += 1) {
        var sizePage = await pdfjsDoc.getPage(pageIndex + 1);
        var sizeViewport = sizePage.getViewport({ scale: 1 });
        state.pageSizes.push({ width: sizeViewport.width, height: sizeViewport.height });
      }
      if (token !== state.loadToken) {
        return;
      }
      state.formFields = readFormFields(pdfDoc);
      await collectAnnotationFields();
      if (token !== state.loadToken) {
        return;
      }
      state.currentPage = 0;
      $("#outputName").value = makeOutputName(file.name);
      renderFieldList();
      renderPageRail();
      await renderCurrentPage();
      if (token !== state.loadToken) {
        return;
      }
      if (state.encrypted) {
        setBusy(false, "This PDF is password-protected — the filled copy can't be saved. Remove the password first.", "warn");
      } else {
        setBusy(false, "Ready");
      }
    } catch (error) {
      if (token !== state.loadToken) {
        return;
      }
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
    var buttonValue = annotation.buttonValue === null || annotation.buttonValue === undefined ? "" : String(annotation.buttonValue);
    if (buttonValue) {
      var options = field && field.options ? field.options : [];
      if (!options.length || options.indexOf(buttonValue) !== -1) {
        return buttonValue;
      }
      if (/^\d+$/.test(buttonValue) && options[Number(buttonValue)] !== undefined) {
        // PDFs with /Opt arrays name widget on-states by option index.
        return options[Number(buttonValue)];
      }
      return buttonValue;
    }
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

    state.renderGeneration += 1;
    var generation = state.renderGeneration;
    var pdfjsDoc = state.pdfjsDoc;
    var page = await pdfjsDoc.getPage(state.currentPage + 1);
    if (generation !== state.renderGeneration || pdfjsDoc !== state.pdfjsDoc) {
      return;
    }
    var base = page.getViewport({ scale: 1 });
    var maxWidth = Math.min(920, Math.max(320, $("#pageStage").clientWidth - 24));
    var scale = Math.min(1.7, maxWidth / Math.max(1, base.width));
    var viewport = page.getViewport({ scale: scale });
    state.currentViewport = viewport;
    if (state.renderTask) {
      try {
        state.renderTask.cancel();
      } catch (error) {
        // A task that already settled cannot be cancelled.
      }
    }
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
    var renderTask = page.render({ canvasContext: context, viewport: viewport });
    state.renderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (error) {
      if (state.renderTask === renderTask) {
        state.renderTask = null;
      }
      if (error && error.name === "RenderingCancelledException") {
        return;
      }
      throw error;
    }
    if (state.renderTask === renderTask) {
      state.renderTask = null;
    }
    if (generation !== state.renderGeneration || pdfjsDoc !== state.pdfjsDoc) {
      return;
    }
    try {
      state.currentAnnotations = (await page.getAnnotations({ intent: "display" })).filter(isFillableAnnotation);
      state.currentAnnotations.forEach(ensureAnnotationField);
    } catch (error) {
      state.currentAnnotations = [];
    }
    if (generation !== state.renderGeneration || pdfjsDoc !== state.pdfjsDoc) {
      return;
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
      "font-size:" + getMarkPreviewFontSize(mark) + "px",
      "color:" + escapeAttr(mark.color)
    ].join(";");
    var selected = mark.id === state.selectedMarkId ? " selected" : "";
    var dragButton = '<button class="mark-drag" type="button" data-drag-mark="' + escapeAttr(mark.id) + '" aria-label="Move mark"></button>';
    var deleteButton = '<button class="mark-delete" type="button" data-delete-mark="' + escapeAttr(mark.id) + '" aria-label="Delete mark">x</button>';
    var resizeHandle = '<span class="mark-resize" data-resize-mark="' + escapeAttr(mark.id) + '" aria-hidden="true"></span>';
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
      mark.text = $("#markDate").value || getLocalDateValue();
      mark.width = 0.22;
      mark.autoSize = true;
    } else if (tool === "initials") {
      if (!state.savedInitialsDataUrl) {
        openInkDialog("initials");
        return null;
      }
      mark.dataUrl = state.savedInitialsDataUrl;
      mark.width = clampNumber($("#signatureScale").value, 8, 95, state.imageWidthDefaults.initials) / 100;
      mark.height = imageHeightFraction(mark.width, state.savedInitialsAspect, mark.pageIndex);
    } else if (tool === "check") {
      mark.size = Math.max(18, size);
      applyCheckBoxFromSize(mark);
    } else if (tool === "signature") {
      if (!state.savedSignatureDataUrl) {
        openInkDialog("signature");
        return null;
      }
      mark.dataUrl = state.savedSignatureDataUrl;
      mark.width = clampNumber($("#signatureScale").value, 8, 95, state.imageWidthDefaults.signature) / 100;
      mark.height = imageHeightFraction(mark.width, state.savedSignatureAspect, mark.pageIndex);
    }
    autoSizeTextMark(mark);
    return mark;
  }

  function getPageDisplaySize(pageIndex) {
    return state.pageSizes[pageIndex] || { width: 612, height: 792 };
  }

  function imageHeightFraction(widthFraction, aspect, pageIndex) {
    var pageSize = getPageDisplaySize(pageIndex);
    return widthFraction * aspect * (pageSize.width / Math.max(1, pageSize.height));
  }

  function applyCheckBoxFromSize(mark) {
    var pageSize = getPageDisplaySize(mark.pageIndex);
    var checkSize = Math.max(14, mark.size * 1.12);
    mark.width = Math.min(Math.max(0.01, 1 - mark.x), checkSize / Math.max(1, pageSize.width));
    mark.height = Math.min(Math.max(0.01, 1 - mark.y), checkSize / Math.max(1, pageSize.height));
  }

  function getMarkPreviewFontSize(mark) {
    var scale = state.currentViewport ? state.currentViewport.scale : 1;
    if (mark.type === "check" && state.currentViewport) {
      var boxWidth = mark.width * state.currentViewport.width;
      var boxHeight = mark.height * state.currentViewport.height;
      return Math.max(8, Math.min(boxWidth, boxHeight) * 0.9);
    }
    return Math.max(1, mark.size * scale);
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
      var viewScale = state.currentViewport ? Math.max(0.01, state.currentViewport.scale) : 1;
      mark.size = Math.max(12, (Math.min(widthPx, heightPx) / viewScale) * 0.9);
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
      $("#selectedSizeValue").textContent = Math.round(selected.size) + " pt";
      renderOverlayFromCurrent();
    } else if (event.target.id === "selectedPage" && selected) {
      selected.pageIndex = Number(event.target.value);
      state.currentPage = selected.pageIndex;
      renderCurrentPage().catch(reportRenderError);
    }
    syncControls();
  }

  function handleToolbarInput(event) {
    syncToolbarValueLabels();
    var selected = getSelectedMark();
    if (event.target.id === "signatureScale") {
      var percent = Math.round(clampNumber(event.target.value, 8, 95, 34));
      if (selected && isImageMark(selected)) {
        state.imageWidthDefaults[selected.type === "initials" ? "initials" : "signature"] = percent;
      } else if (state.activeTool === "signature" || state.activeTool === "initials") {
        state.imageWidthDefaults[state.activeTool] = percent;
      }
    }
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
    } else if (event.target.id === "markDate" && selected.type === "date" && event.target.value) {
      selected.text = event.target.value;
      autoSizeTextMark(selected);
      renderOverlayFromCurrent();
      renderSelectedControls();
    }
    syncToolbarValues();
  }

  function applySizeToMark(mark, size) {
    mark.size = clampNumber(size, 8, 96, mark.size || 16);
    if (isTextMark(mark)) {
      mark.autoSize = true;
      autoSizeTextMark(mark);
    } else if (mark.type === "check") {
      applyCheckBoxFromSize(mark);
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

    if (!state.detailsAutoOpened && $("#fillForm").hidden) {
      state.detailsAutoOpened = true;
      toggleDetails();
    }
    $("#selectedText").disabled = isImageMark(mark) || mark.type === "check";
    $("#selectedText").value = mark.type === "check" ? "✓" : mark.text || "";
    $("#selectedColor").value = mark.color || "#111827";
    $("#selectedColor").disabled = isImageMark(mark);
    $("#selectedSize").disabled = isImageMark(mark);
    $("#selectedSize").value = Math.round(mark.size);
    $("#selectedSizeValue").textContent = Math.round(mark.size) + " pt";
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
    mark.text = readEditableText(editable);
    editable.dataset.empty = String(!mark.text);
    autoSizeTextMark(mark);
    updateMarkElementLayout(mark);
    if (mark.id === state.selectedMarkId) {
      renderSelectedControls();
    }
    updateStats();
  }

  function readEditableText(element) {
    // innerText preserves <br> and block boundaries as newlines; textContent flattens them.
    var text = String(element.innerText || "").replace(/\r\n?/g, "\n");
    return text.replace(/\n$/, "");
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
    if (event.key === "Tab" && !$("#inkDialog").hidden) {
      trapInkDialogFocus(event);
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

  function trapInkDialogFocus(event) {
    var dialog = $("#inkDialog");
    var focusable = $$("#inkDialog canvas, #inkDialog input, #inkDialog button").filter(function (element) {
      return !element.disabled;
    });
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    var active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
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
    element.style.fontSize = getMarkPreviewFontSize(mark) + "px";
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
    measurer.style.fontSize = getMarkPreviewFontSize(mark) + "px";
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
    if (state.activeTool === "signature" || state.activeTool === "initials") {
      var selected = getSelectedMark();
      if (!selected || !isImageMark(selected)) {
        $("#signatureScale").value = String(state.imageWidthDefaults[state.activeTool]);
        syncToolbarValueLabels();
      }
    }
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
    renderCurrentPage().catch(reportRenderError);
    syncControls();
  }

  async function downloadFilledPdf() {
    if (!state.bytes) {
      setStatus("Choose a PDF first", "warn");
      return;
    }
    if (state.encrypted) {
      setStatus("This PDF is password-protected — the filled copy can't be saved. Remove the password first.", "warn");
      return;
    }

    setBusy(true, "Building filled PDF");
    try {
      var flattening = $("#flattenFields").checked;
      var result = await buildFilledPdf();
      downloadBlob(new Blob([result.bytes], { type: "application/pdf" }), getOutputName());
      var summary = formatBytes(result.bytes.length) + (flattening ? " flattened PDF ready" : " PDF ready; fields editable");
      var warningText = describeExportWarnings(result.warnings);
      if (warningText) {
        setBusy(false, summary + "; " + warningText, "warn");
      } else {
        setBusy(false, summary);
      }
    } catch (error) {
      setBusy(false, getErrorMessage(error), "danger");
    }
  }

  function describeExportWarnings(warnings) {
    var parts = [];
    var chars = Object.keys(warnings.characters || {});
    if (chars.length) {
      var samples = chars.slice(0, 6).map(function (char) {
        var replacement = warnings.characters[char];
        return replacement ? '"' + char + '" → "' + replacement + '"' : '"' + char + '" removed';
      });
      parts.push("replaced unsupported characters: " + samples.join(", ") + (chars.length > 6 ? ", …" : ""));
    }
    if (warnings.fields && warnings.fields.length) {
      parts.push("could not fill fields: " + warnings.fields.slice(0, 4).join(", ") + (warnings.fields.length > 4 ? ", …" : ""));
    }
    if (warnings.flatten) {
      parts.push("form fields could not be flattened");
    }
    if (warnings.appearances) {
      parts.push("some field appearances were not updated");
    }
    return parts.join("; ");
  }

  async function buildFilledPdf() {
    var PDFLib = window.PDFLib;
    var doc = await PDFLib.PDFDocument.load(state.bytes, {
      ignoreEncryption: true,
      updateMetadata: false
    });
    var warnings = { characters: {}, fields: [], flatten: false, appearances: false };
    var regular = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    var bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);

    applyFormValues(doc, regular, warnings);

    if ($("#flattenFields").checked) {
      try {
        doc.getForm().flatten();
      } catch (error) {
        // PDFs without AcroForm fields do not need flattening.
        warnings.flatten = hasAnyFormField(doc);
      }
    }

    var signatureImages = {};

    for (var index = 0; index < state.marks.length; index += 1) {
      var mark = state.marks[index];
      var page = doc.getPages()[mark.pageIndex];
      if (!page) {
        continue;
      }
      if (isImageMark(mark)) {
        if (!signatureImages[mark.dataUrl]) {
          signatureImages[mark.dataUrl] = await doc.embedPng(dataUrlToBytes(mark.dataUrl));
        }
        drawSignatureMark(page, mark, signatureImages[mark.dataUrl]);
      } else if (mark.type === "check") {
        drawCheckMark(page, mark);
      } else {
        drawTextMark(page, mark, mark.type === "initials" ? bold : regular, warnings);
      }
    }

    doc.setCreator("Fill Freely");
    doc.setProducer("Fill Freely");
    doc.setModificationDate(new Date());
    var bytes;
    try {
      bytes = await doc.save({
        useObjectStreams: true,
        updateFieldAppearances: true
      });
    } catch (error) {
      // Appearance regeneration can fail on fields whose values need glyphs the
      // default form font cannot encode; keep the original appearances instead.
      bytes = await doc.save({
        useObjectStreams: true,
        updateFieldAppearances: false
      });
      warnings.appearances = true;
    }
    return { bytes: bytes, warnings: warnings };
  }

  function hasAnyFormField(doc) {
    try {
      return doc.getForm().getFields().length > 0;
    } catch (error) {
      return false;
    }
  }

  function applyFormValues(doc, font, warnings) {
    var form;
    try {
      form = doc.getForm();
    } catch (error) {
      return;
    }

    state.formFields.forEach(function (field) {
      try {
        if (field.type === "text") {
          form.getTextField(field.name).setText(sanitizeTextForFont(field.value || "", font, warnings));
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
        // Leave unsupported or malformed fields unchanged, but tell the user.
        if (warnings && warnings.fields.indexOf(field.name) === -1) {
          warnings.fields.push(field.name);
        }
      }
    });
  }

  var EXPORT_CHAR_REPLACEMENTS = {
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'", "\u2032": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"', "\u2033": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-",
    "\u2026": "...",
    "\t": " ", "\u00A0": " ", "\u2007": " ", "\u202F": " ", "\u3000": " ",
    "\u200B": "", "\u200C": "", "\u200D": "", "\uFEFF": "",
    "\u2028": "\n", "\u2029": "\n"
  };
  // Whitespace and zero-width normalizations that are not worth a warning.
  var SILENT_CHAR_REPLACEMENTS = {
    "\t": true, "\u00A0": true, "\u2007": true, "\u202F": true, "\u3000": true,
    "\u200B": true, "\u200C": true, "\u200D": true, "\uFEFF": true,
    "\u2028": true, "\u2029": true
  };
  var fontCharSetCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function getFontCharSet(font) {
    if (fontCharSetCache && fontCharSetCache.has(font)) {
      return fontCharSetCache.get(font);
    }
    var set = null;
    try {
      if (typeof font.getCharacterSet === "function") {
        set = new Set(font.getCharacterSet());
      }
    } catch (error) {
      set = null;
    }
    if (fontCharSetCache) {
      fontCharSetCache.set(font, set);
    }
    return set;
  }

  function canEncodeChar(font, char) {
    var supported = getFontCharSet(font);
    if (supported) {
      return supported.has(char.codePointAt(0));
    }
    try {
      font.widthOfTextAtSize(char, 10);
      return true;
    } catch (error) {
      return false;
    }
  }

  function sanitizeTextForFont(text, font, warnings) {
    var source = String(text || "").replace(/\r\n?/g, "\n");
    var result = "";
    for (var index = 0; index < source.length; index += 1) {
      var char = source[index];
      var code = source.codePointAt(index);
      if (code > 0xffff) {
        char = source.slice(index, index + 2);
        index += 1;
      }
      if (char === "\n") {
        result += char;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(EXPORT_CHAR_REPLACEMENTS, char)) {
        result += EXPORT_CHAR_REPLACEMENTS[char];
        recordCharChange(warnings, char, EXPORT_CHAR_REPLACEMENTS[char]);
        continue;
      }
      if (canEncodeChar(font, char)) {
        result += char;
      } else {
        recordCharChange(warnings, char, "");
      }
    }
    return result;
  }

  function recordCharChange(warnings, from, to) {
    if (warnings && warnings.characters && from !== to && !SILENT_CHAR_REPLACEMENTS[from]) {
      warnings.characters[from] = to;
    }
  }

  // Marks are stored as fractions of the page as PDF.js displays it: the
  // CropBox with /Rotate applied. Export must map those display-space points
  // back into unrotated PDF user space (and add the CropBox origin).
  function getPageGeometry(page) {
    var crop = page.getCropBox();
    var angle = page.getRotation ? page.getRotation().angle : 0;
    var rotation = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
    var swapped = rotation === 90 || rotation === 270;
    return {
      crop: crop,
      rotation: rotation,
      width: swapped ? crop.height : crop.width,
      height: swapped ? crop.width : crop.height
    };
  }

  // (dx, dy) is a display-space point: dx from the left edge, dy from the TOP
  // edge of the page as previewed. Returns unrotated PDF user-space coords.
  function displayPointToPdf(geometry, dx, dy) {
    var crop = geometry.crop;
    if (geometry.rotation === 90) {
      return { x: crop.x + dy, y: crop.y + dx };
    }
    if (geometry.rotation === 180) {
      return { x: crop.x + crop.width - dx, y: crop.y + dy };
    }
    if (geometry.rotation === 270) {
      return { x: crop.x + crop.width - dy, y: crop.y + crop.height - dx };
    }
    return { x: crop.x + dx, y: crop.y + crop.height - dy };
  }

  function drawTextMark(page, mark, font, warnings) {
    var geometry = getPageGeometry(page);
    var fontSize = mark.size;
    var text = sanitizeTextForFont(mark.text || "", font, warnings);
    var maxWidth = Math.max(fontSize, mark.width * geometry.width + fontSize * 0.35);
    var lines = wrapText(text, font, fontSize, maxWidth);
    var color = hexToRgb(mark.color);
    var rotate = window.PDFLib.degrees(geometry.rotation);
    lines.forEach(function (line, index) {
      var dx = mark.x * geometry.width;
      var dy = mark.y * geometry.height + fontSize + index * fontSize * 1.15;
      var point = displayPointToPdf(geometry, dx, dy);
      page.drawText(line, {
        x: point.x,
        y: point.y,
        size: fontSize,
        font: font,
        color: color,
        rotate: rotate
      });
    });
  }

  function drawCheckMark(page, mark) {
    var geometry = getPageGeometry(page);
    var width = Math.max(10, mark.width * geometry.width);
    var height = Math.max(10, mark.height * geometry.height);
    var left = mark.x * geometry.width;
    var top = mark.y * geometry.height;
    var color = hexToRgb(mark.color);
    var thickness = Math.max(2, width * 0.12);
    // fx measures from the box's left edge, fy from its bottom edge, both in
    // display orientation; endpoints are mapped so no rotate option is needed.
    var point = function (fx, fy) {
      return displayPointToPdf(geometry, left + fx * width, top + (1 - fy) * height);
    };
    page.drawLine({
      start: point(0.08, 0.45),
      end: point(0.38, 0.12),
      thickness: thickness,
      color: color
    });
    page.drawLine({
      start: point(0.38, 0.12),
      end: point(0.94, 0.9),
      thickness: thickness,
      color: color
    });
  }

  function drawSignatureMark(page, mark, image) {
    var geometry = getPageGeometry(page);
    var width = mark.width * geometry.width;
    var height = mark.height * geometry.height;
    // Anchor at the display-space bottom-left corner of the image box; with
    // the matching rotate option the image spans the previewed rectangle.
    var anchor = displayPointToPdf(geometry, mark.x * geometry.width, mark.y * geometry.height + height);
    page.drawImage(image, {
      x: anchor.x,
      y: anchor.y,
      width: width,
      height: height,
      rotate: window.PDFLib.degrees(geometry.rotation)
    });
  }

  function wrapText(text, font, fontSize, maxWidth) {
    var lines = [];
    String(text || "").replace(/\r\n?/g, "\n").split("\n").forEach(function (rawLine) {
      var words = rawLine.split(/\s+/).filter(Boolean);
      if (!words.length) {
        lines.push("");
        return;
      }
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
    });
    return lines.length ? lines : [""];
  }

  function initSignaturePad() {
    var canvas = $("#signaturePad");
    var context = canvas.getContext("2d");
    var drawing = false;
    var lastPoint = null;
    applyInkPadStrokeStyle(context);

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
    state.inkReturnFocus = document.activeElement;
    $("#typedInkText").placeholder = tool === "initials" ? "Type initials" : "Type a signature";
    $("#inkTitle").textContent = tool === "initials" ? "Create initials" : "Create signature";
    $("#inkNote").textContent = tool === "initials"
      ? "Draw your initials or type them to generate a reusable initials mark."
      : "Draw your signature or type your name to generate a reusable visual signature. This is not a cryptographic digital signature.";
    $("#useSignature").textContent = tool === "initials" ? "Save initials and place" : "Save signature and place";
    $("#inkDialog").hidden = false;
    sizeInkPad();
    clearInkPad();
    window.requestAnimationFrame(function () {
      $("#signaturePad").focus();
    });
  }

  function closeInkDialog() {
    $("#inkDialog").hidden = true;
    state.inkTool = "";
    clearInkPad();
    var returnFocus = state.inkReturnFocus;
    state.inkReturnFocus = null;
    if (returnFocus && typeof returnFocus.focus === "function" && document.contains(returnFocus)) {
      returnFocus.focus();
    }
  }

  // Match the canvas backing store to its CSS size so drawn strokes are not
  // stretched, and render crisply on high-DPI screens.
  function sizeInkPad() {
    var canvas = $("#signaturePad");
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    var ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    var context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    applyInkPadStrokeStyle(context);
  }

  function applyInkPadStrokeStyle(context) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 5;
    context.strokeStyle = "#111827";
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
    $("#downloadPdf").disabled = !hasPdf || state.encrypted;
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
    state.imageWidthDefaults = { signature: 34, initials: 12 };
    setDefaultDate();
    setTool("");
    setStatus("Ready");
    syncControls();
  }

  function resetDocument(clearFileInput) {
    if (state.renderTask) {
      try {
        state.renderTask.cancel();
      } catch (error) {
        // A task that already settled cannot be cancelled.
      }
      state.renderTask = null;
    }
    state.renderGeneration += 1;
    if (state.pdfjsDoc && state.pdfjsDoc.destroy) {
      state.pdfjsDoc.destroy();
    }
    state.encrypted = false;
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
    $("#markDate").value = getLocalDateValue();
  }

  function getLocalDateValue() {
    var now = new Date();
    return now.getFullYear() + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0");
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
    // The ink pad context is scaled by devicePixelRatio, so drawing happens in
    // CSS pixel coordinates.
    var rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
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
