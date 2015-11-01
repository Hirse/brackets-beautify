define(function (require) {
    'use strict';

    var PREFIX = 'hirse.beautify';
    var COMMAND_ID = PREFIX + '.beautify';
    var COMMAND_SAVE_ID = PREFIX + '.autosave';

    /* beautify preserve:start */
    var CommandManager     = brackets.getModule('command/CommandManager');
    var Commands           = brackets.getModule('command/Commands');
    var Menus              = brackets.getModule('command/Menus');
    var DocumentManager    = brackets.getModule('document/DocumentManager');
    var Editor             = brackets.getModule('editor/Editor').Editor;
    var EditorManager      = brackets.getModule('editor/EditorManager');
    var FileSystem         = brackets.getModule('filesystem/FileSystem');
    var FileSystemError    = brackets.getModule('filesystem/FileSystemError');
    var LanguageManager    = brackets.getModule('language/LanguageManager');
    var LiveDevelopment    = brackets.getModule('LiveDevelopment/LiveDevelopment');
    var PreferencesManager = brackets.getModule('preferences/PreferencesManager');
    var ProjectManager     = brackets.getModule('project/ProjectManager');
    var AppInit            = brackets.getModule('utils/AppInit');
    var DefaultDialogs     = brackets.getModule('widgets/DefaultDialogs');
    var Dialogs            = brackets.getModule('widgets/Dialogs');
    /* beautify preserve:end */

    var Strings = require('strings');
    var beautifiers = {
        js: require('thirdparty/beautify').js_beautify,
        css: require('thirdparty/beautify-css').css_beautify,
        html: require('thirdparty/beautify-html').html_beautify
    };

    var settingsFileName = '.jsbeautifyrc';
    var settings = JSON.parse(require('text!default.jsbeautifyrc'));
    var beautifyPrefs = PreferencesManager.getExtensionPrefs(PREFIX);
    var keyBindings = [
        {
            key: 'Ctrl-Shift-L',
            platform: 'win'
        }, {
            key: 'Ctrl-Alt-B',
            platform: 'win'
        }, {
            key: 'Cmd-Shift-L',
            platform: 'mac'
        }, {
            key: 'Ctrl-Alt-B'
        }
    ];

    var beautifyOnSave = beautifyPrefs.get('onSave') || false;
    if (!beautifyOnSave) {
        beautifyPrefs.set('onSave', false);
        beautifyPrefs.save();
    }

    function batchUpdate(formattedText, range) {
        var editor = EditorManager.getCurrentFullEditor();
        var cursorPos = editor.getCursorPos();
        var scrollPos = editor.getScrollPos();
        var document = DocumentManager.getCurrentDocument();
        document.batchOperation(function () {
            if (range) {
                document.replaceRange(formattedText, range.start, range.end);
            } else {
                document.setText(formattedText);
            }
            editor.setCursorPos(cursorPos);
            editor.setScrollPos(scrollPos.x, scrollPos.y);
        });
    }

    function format(autoSave) {
        var beautifierType;
        var document = DocumentManager.getCurrentDocument();
        switch (document.getLanguage().getId()) {
            case 'javascript':
            case 'json':
                beautifierType = 'js';
                break;
            case 'html':
            case 'xml':
            case 'svg':
            case 'php':
            case 'ejs':
            case 'handlebars':
                beautifierType = 'html';
                break;
            case 'css':
            case 'scss':
            case 'less':
                beautifierType = 'css';
                break;
            default:
                if (!autoSave) {
                    Dialogs.showModalDialog(DefaultDialogs.DIALOG_ID_ERROR, Strings.UNSUPPORTED_TITLE, Strings.UNSUPPORTED_MESSAGE);
                }
                return;
        }

        var unformattedText;
        var editor = EditorManager.getCurrentFullEditor();
        var options = $.extend({}, settings[beautifierType] || settings);
        if (Editor.getUseTabChar()) {
            options.indent_with_tabs = true;
        } else {
            options.indent_size = Editor.getSpaceUnits();
            options.indent_char = ' ';
        }
        var range;
        if (editor.hasSelection()) {
            options.indentation_level = editor.getSelection().start.ch;
            options.end_with_newline = false;
            unformattedText = editor.getSelectedText();
            range = editor.getSelection();
        } else {
            unformattedText = document.getText();
            /*
             * If the current document is html and is currently used in LiveDevelopment, we must not change the html tag
             * as that causes the DOM in the browser to duplicate (see https://github.com/adobe/brackets/issues/10634).
             * To prevent that, we select the content inside <html> if we can find one and pretend a selection for the
             * formatting and replacing.
             * NOTE: Currently it is only checked if LiveDevelopment is active in general as I don't know how to check
             * for a specific file (see https://groups.google.com/forum/#!topic/brackets-dev/9wEtqG684cI).
             */
            if (document.getLanguage().getId() === 'html' && LiveDevelopment.status === LiveDevelopment.STATUS_ACTIVE) {
                // Regex to match everything inside <html> beginning by the first tag and ending at the last
                var match = /((?:.|\n)*<html[^>]*>\s*)((?:.|\n)*?)(\s*<\/html>)/gm.exec(unformattedText);
                if (match) {
                    unformattedText = match[2];
                    range = {
                        start: {
                            line: match[1].split('\n').length - 1,
                            ch: match[1].length - match[1].lastIndexOf('\n') - 1
                        },
                        end: {
                            line: (match[1] + match[2]).split('\n').length - 1,
                            ch: (match[1] + match[2]).length - (match[1] + match[2]).lastIndexOf('\n') - 1
                        }
                    };
                    options.end_with_newline = false;
                }
            }
        }
        var formattedText = beautifiers[beautifierType](unformattedText, options);
        if (formattedText !== unformattedText) {
            batchUpdate(formattedText, range);
        }
    }

    function onSave(event, doc) {
        if (doc.__beautifySaving) {
            return;
        }
        var context = PreferencesManager._buildContext(doc.file.fullPath, doc.getLanguage().getId());
        if (beautifyPrefs.get('onSave', context)) {
            doc.addRef();
            doc.__beautifySaving = true;
            format(true);
            setTimeout(function () {
                CommandManager.execute(Commands.FILE_SAVE, {
                    doc: doc
                }).always(function () {
                    delete doc.__beautifySaving;
                    doc.releaseRef();
                });
            });
        }
    }

    function loadConfig(settingsFile) {
        if (!settingsFile) {
            settingsFile = FileSystem.getFileForPath(ProjectManager.getProjectRoot().fullPath + settingsFileName);
        }
        settingsFile.read(function (err, content) {
            if (err === FileSystemError.NOT_FOUND) {
                return;
            }
            try {
                settings = JSON.parse(content);
            } catch (e) {
                console.error('Brackets Beautify - Error parsing options (' + settingsFile.fullPath + '). Using default.');
                return;
            }
        });
    }

    function loadConfigOnChange(e, document) {
        if (document.file.fullPath === ProjectManager.getProjectRoot().fullPath + settingsFileName) {
            loadConfig(document.file);
        }
    }

    function toggle(command, fromCheckbox) {
        var newValue = (typeof fromCheckbox === 'undefined') ? beautifyOnSave : fromCheckbox;
        DocumentManager[newValue ? 'on' : 'off']('documentSaved', onSave);
        command.setChecked(newValue);
        beautifyPrefs.set('onSave', newValue);
        beautifyPrefs.save();
    }

    CommandManager.register(Strings.BEAUTIFY, COMMAND_ID, format);
    var commandOnSave = CommandManager.register(Strings.BEAUTIFY_ON_SAVE, COMMAND_SAVE_ID, function () {
        toggle(this, !this.getChecked());
    });
    toggle(commandOnSave);

    var editMenu = Menus.getMenu(Menus.AppMenuBar.EDIT_MENU);
    editMenu.addMenuDivider();
    editMenu.addMenuItem(COMMAND_ID, keyBindings);
    editMenu.addMenuItem(COMMAND_SAVE_ID);
    Menus.getContextMenu(Menus.ContextMenuIds.EDITOR_MENU).addMenuItem(COMMAND_ID);

    var jsonLanguage = LanguageManager.getLanguage('json');
    jsonLanguage.addFileExtension(settingsFileName);
    jsonLanguage.addFileName(settingsFileName);

    AppInit.appReady(function () {
        DocumentManager.on('documentSaved.beautify', loadConfigOnChange);
        DocumentManager.on('documentRefreshed.beautify', loadConfigOnChange);
        ProjectManager.on('projectOpen.beautify', function () {
            loadConfig();
        });
        loadConfig();
    });
});
